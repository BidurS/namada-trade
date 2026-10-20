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
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Flow } from '../../../../shared/types';
import { fetchFlows, flowsCsvHref, type FlowsQuery } from '../../api';
import { navigate, osmosisStreaming, streamStamp, useClock, useOverlays, useOverview, useReplay } from '../../app/index';
import { Button, EmptyState, Notice, Num, Pager, ProvScope, Segmented, SelectChip, Skeleton, SourceLine, TxList, stepFor, type ScopeItem, type Stamp } from '../../ui';
import { kindInfo, type TagKind } from '../../lib/kinds';
import { applyFlowRules, isBot } from '../../lib/flows';
import { fmtAge, fmtCount, fmtUtcLong } from '../../lib/format';
import { ActivityBar, FilterPanel, FilterSet, SearchField } from './parts';
import { FLOW_CSV_MAX as CSV_MAX, PAGE_SIZE as PAGE, focusFirstRow, pageCount, pageHref } from './paging';

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
  page,
}: {
  filters: TxFilters;
  setFilters: (f: TxFilters) => void;
  wide: boolean;
  /** The page from ?page= (1 when absent). */
  page: number;
}) {
  const { at, rewound } = useReplay();
  const now = useClock();
  const { overview, liveFlows, streamedIds, stream } = useOverview();
  const { openAddress } = useOverlays();
  const [sheet, setSheet] = useState(false);

  // ---- the page from the URL for these filters; a page change replaces the rows
  const key = JSON.stringify([filters, at]);
  // exact: `total` is the count of these filters (false: an older server ignored a rule, and `total` is only an
  // upper bound); more: the server holds rows after this page
  const [data, setData] = useState<{ key: string; flows: Flow[]; total: number; page: number; exact: boolean; more: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const q: FlowsQuery = { asOf: at, chain: filters.chain, kind: filters.kind, search: filters.search, ...rulesOf(filters) };
  useEffect(() => {
    let live = true;
    setError(null);
    fetchFlows({ ...q, page, limit: PAGE })
      .then((r) => live && setData({ key, flows: r.flows, total: r.total, page, exact: r.exact, more: r.more }))
      .catch(() => live && setError(page > 1 ? 'This page of moves could not be fetched from this site’s server.' : 'The list of moves could not be fetched from this site’s server.'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, page, retry]);

  // ---- streamed moves on top (live only, never the load-time seed)
  // the same filters (any page): the count stays while another page loads
  const fresh = data?.key === key ? data : null;
  const rows = useMemo(() => {
    if (!fresh) return [];
    if (rewound || fresh.page !== 1) return fresh.flows;
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
  // the number of pages only when the count is exact; otherwise "of —" and the next page while the server has more
  const pages = fresh && exact && total != null ? pageCount(total) : null;
  const past = !!fresh && fresh.page === page && pages != null && page > pages;
  useEffect(() => {
    if (past && pages != null) navigate(pageHref(pages), { replace: true, scroll: false });
  }, [past, pages]);

  // ---- a page change scrolls to the list's head and, once the rows are in, focuses the first row
  const headRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);
  const onGo = () => {
    focusNext.current = true;
    headRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
  };
  useEffect(() => {
    if (!focusNext.current || !data || data.key !== key || data.page !== page) return;
    focusNext.current = false;
    requestAnimationFrame(() => focusFirstRow(headRef.current, listRef.current, '.tx'));
  }, [data, key, page]);
  /** `[` and `]` on a list row step a page, as they do inside the pager. */
  const onListKey = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey || (e.target as HTMLElement).closest('input, textarea, select')) return;
    const to = stepFor(e.key, page, pages, fresh?.more);
    if (to == null) return;
    e.preventDefault();
    onGo();
    navigate(pageHref(to), { scroll: false });
  };

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

  const busy = !!data && (data.key !== key || data.page !== page || past);
  const empty = !!fresh && !busy && rows.length === 0;
  const pager = (where: 'head' | 'foot') =>
    fresh ? (
      <Pager
        label={where === 'head' ? 'Pages of moves' : 'Pages of moves, under the list'}
        page={page}
        pages={pages}
        hrefFor={pageHref}
        onGo={onGo}
        hasNext={fresh.more}
        run={where === 'foot'}
        className={`act-pager act-pager--${where}`}
        unknown={where === 'foot' ? 'The number of pages is not known: this site’s server did not count the moves these filters select, so only the next page is offered.' : undefined}
      />
    ) : (
      <div className="pager act-pager act-pager--ph" aria-hidden="true" />
    );

  return (
    <>
      <ActivityBar view="activity" wide={wide} filterCount={count} filterOpen={sheet} onFilter={() => setSheet(true)} search={wide ? search(true) : null} />
      <FilterPanel wide={wide} open={sheet} onClose={() => setSheet(false)} title="Filter moves" show={showLabel}>
        {controls}
      </FilterPanel>

      <ProvScope className="act-scope" id="act-tx-scope" aria-busy={busy || !data || undefined}>
        <div className="act-head" ref={headRef}>
          <p className="act-count" aria-live="polite">
            {total == null ? (
              <span className="skel__b act-count__sk" aria-hidden="true" />
            ) : (
              <>
                A total of {exact ? null : 'at least '}
                <Num v={total} fmt={fmtCount} /> {total === 1 ? 'move' : 'moves'} found
                {count ? (total === 1 ? ' that matches the filters' : ' that match the filters') : null}
                {rewound && at ? <>, at or before {fmtUtcLong(at)}</> : null}, newest first.
                {!rewound ? (
                  <span className="act-live" data-status={!stream.connected ? 'none' : streaming === false ? 'old' : 'fresh'}>
                    <i className="dot" data-status={!stream.connected ? 'none' : streaming === false ? 'old' : 'fresh'} aria-hidden="true" />
                    {!stream.connected ? 'Not streaming right now' : streaming === false ? 'Osmosis moves are not streaming right now; Namada moves are' : page > 1 ? 'New moves are added to the first page as they are recorded' : 'New moves appear as they are recorded'}
                  </span>
                ) : null}
              </>
            )}
          </p>
          <div className="act-head__end">
            {fresh && (total ?? 0) > 0 ? (
              <a className="link act-csv" href={flowsCsvHref(q)} download>
                <span>Download page data</span>
                {/* the export holds at most the newest CSV_MAX moves (worker/src/api.ts /api/export/flows) */}
                <span className="act-csv__n">{!exact || (total != null && total > CSV_MAX) ? `CSV, newest ${fmtCount(CSV_MAX)}` : 'CSV, all of them'}</span>
              </a>
            ) : null}
            {pager('head')}
          </div>
        </div>
        {covAt != null ? (
          <p className="scope__old act-lag">
            <i className="dot" data-status="old" aria-hidden="true" />
            <span>{Number.isFinite(covAt) ? <>The flow index last checked the chain {fmtAge(now - covAt)} ago, so later moves may not be listed yet.</> : <>The flow index has no recorded time, so later moves may not be listed yet.</>}</span>
          </p>
        ) : null}

        {error && fresh ? (
          <Notice tone="warning" title="This page did not load" action={<Button size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>}>
            {error}
          </Notice>
        ) : null}
        {error && !fresh ? (
          <Notice tone="warning" title="The moves did not load" action={<Button size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>}>
            {error}
          </Notice>
        ) : !data ? (
          <Skeleton rows={8} heights={[72]} label="moves" className="act-skel" />
        ) : empty ? null : (
          <div className="act-txwide" ref={listRef} onKeyDown={onListKey}>
            <TxList rows={busy ? data.flows : rows} now={now} streamedIds={rewound || page > 1 ? undefined : streamedIds} onAddr={openAddress} busy={busy} />
          </div>
        )}

        {empty ? (
          <EmptyState title="No recorded move matches these filters.">
            {rewound && at ? <>The list holds moves at or before {fmtUtcLong(at)}. </> : null}
            The chain, kind, size and search chosen above leave nothing to show.
          </EmptyState>
        ) : null}

        {data && !empty ? <div className="act-foot">{pager('foot')}</div> : null}

        {scope.length ? <SourceLine items={scope} label="Where the moves come from" /> : <p className="src act-src-ph" aria-hidden="true" />}
      </ProvScope>
    </>
  );
}
