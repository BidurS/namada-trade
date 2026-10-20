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
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Flow } from '../../../../shared/types';
import { fetchFlows, flowsCsvHref, type FlowsQuery } from '../../api';
import { navigate, osmosisStreaming, streamStamp, useClock, useOverlays, useOverview, useReplay } from '../../app/index';
import { Button, EmptyState, Notice, Num, PageTools, Pager, ProvScope, Segmented, SelectChip, Skeleton, SourceLine, TxList, stepFor, type ScopeItem, type Stamp } from '../../ui';
import { useListKeys, type ListKey } from '../../app/keys';
import { kindInfo, type TagKind } from '../../lib/kinds';
import { applyFlowRules, isBot } from '../../lib/flows';
import { fmtAge, fmtCount, fmtDayMonthYear, fmtUtcLong } from '../../lib/format';
import { ActivityBar, FilterPanel, FilterSet, KeysHint, SearchField, useRovingRows } from './parts';
import { FLOW_CSV_MAX as CSV_MAX, PAGE_SIZES, firstVisibleRow, focusFirstRow, focusRow, listHref, pageCount, pageHref, pageOfRank, revealRow } from './paging';

/** A unix-ms time as the date field's yyyy-mm-dd (UTC). */
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

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
  size,
  before,
}: {
  filters: TxFilters;
  setFilters: (f: TxFilters) => void;
  wide: boolean;
  /** The page from ?page= (1 when absent). */
  page: number;
  /** Rows per page, from ?size= (PAGE_SIZE when absent). */
  size: number;
  /** ?before=: only moves before this time (a UTC midnight, unix ms), or null for the newest. */
  before: number | null;
}) {
  const { at, rewound } = useReplay();
  const now = useClock();
  const { overview, liveFlows, streamedIds, stream } = useOverview();
  const { openAddress } = useOverlays();
  const [sheet, setSheet] = useState(false);

  // ---- the page from the URL for these filters; a page change replaces the rows
  // ?before= reads the list as of the last moment before that day, through the same `at` the API takes for
  // Rewind (rows at or before that time); under Rewind the earlier of the two
  const until = before != null ? Math.min(before - 1, at ?? Infinity) : at;
  const dated = before != null && until !== at;
  const key = JSON.stringify([filters, until]);
  // exact: `total` is the count of these filters (false: an older server ignored a rule, and `total` is only an
  // upper bound); more: the server holds rows after this page
  const [data, setData] = useState<{ key: string; flows: Flow[]; total: number; page: number; size: number; exact: boolean; more: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const q: FlowsQuery = { asOf: until, chain: filters.chain, kind: filters.kind, search: filters.search, ...rulesOf(filters) };
  useEffect(() => {
    let live = true;
    setError(null);
    fetchFlows({ ...q, page, limit: size })
      .then((r) => live && setData({ key, flows: r.flows, total: r.total, page, size, exact: r.exact, more: r.more }))
      .catch(() => live && setError(page > 1 ? 'This page of moves could not be fetched from this site’s server.' : 'The list of moves could not be fetched from this site’s server.'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, page, size, retry]);

  // ---- streamed moves on top (live only, never the load-time seed, never under a date)
  // the same filters (any page): the count stays while another page loads
  const fresh = data?.key === key ? data : null;
  const rows = useMemo(() => {
    if (!fresh) return [];
    if (rewound || dated || fresh.page !== 1) return fresh.flows;
    const have = new Set(fresh.flows.map((x) => x.id));
    const newest = fresh.flows[0]?.ts ?? 0;
    const add = liveFlows.filter((x) => streamedIds.has(x.id) && !have.has(x.id) && x.ts >= newest && matches(x, filters));
    return add.length ? applyFlowRules([...add, ...fresh.flows], rulesOf(filters)) : fresh.flows;
  }, [fresh, liveFlows, streamedIds, rewound, dated, filters]);
  const added = fresh ? rows.length - fresh.flows.length : 0;
  const exact = fresh?.exact ?? true;
  // not exact: the count of these filters is not known, only the rows listed
  const total = fresh ? (exact ? fresh.total + Math.max(0, added) : rows.length) : null;
  const streaming = osmosisStreaming(stream, now);
  // the number of pages only when the count is exact; otherwise "of —" and the next page while the server has more
  const pages = fresh && exact && total != null ? pageCount(total, size) : null;
  const current = !!fresh && fresh.page === page && fresh.size === size;
  const past = current && pages != null && page > pages;
  useEffect(() => {
    if (past && pages != null) navigate(pageHref(pages), { replace: true, scroll: false });
  }, [past, pages]);

  // ---- after a page change, once the rows are in: the first row focused, or (a size change) the row that was
  // first in view kept in view
  const headRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ kind: 'first' } | { kind: 'pos'; pos: number } | null>(null);
  useEffect(() => {
    const p = pending.current;
    if (!p || !current || !data || data.key !== key) return;
    pending.current = null;
    requestAnimationFrame(() => {
      if (p.kind === 'first') return focusFirstRow(headRef.current, listRef.current, '.tx');
      const row = listRef.current?.querySelectorAll<HTMLElement>('.tx')[p.pos - (page - 1) * size - 1];
      if (row) revealRow(row, headRef.current, listRef.current, 'top');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, key, current]);
  const onGo = () => {
    pending.current = { kind: 'first' };
    focusFirstRow(headRef.current, listRef.current, '.tx', false);
  };
  const goPage = (n: number) => {
    onGo();
    navigate(pageHref(n), { scroll: false });
  };

  /** Rows per page: a history entry; the page that holds the first move in view, kept in view. */
  const onSize = (n: number) => {
    if (n === size) return;
    const seen = firstVisibleRow(headRef.current, listRef.current, '.tx');
    const pos = seen ? (page - 1) * size + seen.index + 1 : 1;
    pending.current = seen && seen.index > 0 ? { kind: 'pos', pos } : null;
    navigate(listHref({ page: pageOfRank(pos, n), size: n }), { scroll: false });
  };

  /** Show moves from before a day: the list as of the end of the day before (UTC), from its first page. */
  const today = isoDay(Date.now());
  const goBefore = (value: string) => {
    if (!value) {
      if (before == null) return 'Pick a day.';
      navigate(listHref({ before: null, page: 1 }), { scroll: false });
      return null;
    }
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(ms)) return 'Pick a day, such as one from the calendar.';
    if (ms > Date.now()) return 'That day has not come yet; pick today or earlier.';
    pending.current = { kind: 'first' };
    navigate(listHref({ before: ms, page: 1 }), { scroll: false });
    return null;
  };

  // ---- keys (app/keys.ts): j and k walk the rows, Enter opens the move's detail line, [ and ] change the page
  useRovingRows(listRef, '.tx', data);
  useListKeys('.act-txwide .tx', (a: ListKey, row) => {
    const list = listRef.current;
    if (!list) return false;
    if (a.kind === 'page') {
      const to = stepFor(a.step < 0 ? '[' : ']', page, pages, fresh?.more);
      if (to == null) return false;
      goPage(to);
      return true;
    }
    if (a.kind === 'open') {
      row?.querySelector<HTMLButtonElement>('.tx__tog')?.click();
      return !!row;
    }
    const all = [...list.querySelectorAll<HTMLElement>('.tx')];
    if (!all.length) return false;
    let to: HTMLElement | undefined;
    if (a.kind === 'edge') to = a.to === 'first' ? all[0] : all[all.length - 1];
    else if (row) to = all[all.indexOf(row) + a.step];
    else to = firstVisibleRow(headRef.current, list, '.tx')?.row ?? all[0];
    if (!to) return true;
    revealRow(to, headRef.current, list);
    focusRow(to, list, '.tx');
    return true;
  });

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

  const busy = !!data && (data.key !== key || data.page !== page || data.size !== size || past);
  const csv =
    fresh && (total ?? 0) > 0 ? (
      <a className="link act-csv" href={flowsCsvHref(q)} download>
        <span>Download page data</span>
        {/* the export holds at most the newest CSV_MAX moves (worker/src/api.ts /api/export/flows) */}
        <span className="act-csv__n">{!exact || (total != null && total > CSV_MAX) ? `CSV, newest ${fmtCount(CSV_MAX)}` : 'CSV, all of them'}</span>
      </a>
    ) : null;
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
                {dated && before != null ? <>, before {fmtDayMonthYear(before)} (UTC)</> : rewound && at ? <>, at or before {fmtUtcLong(at)}</> : null}, newest first.
                {dated ? (
                  <>
                    {' '}
                    <a className="link act-newest" href={listHref({ before: null, page: 1 })}>
                      Show the newest
                    </a>
                  </>
                ) : null}
                {!rewound && !dated ? (
                  <span className="act-live" data-status={!stream.connected ? 'none' : streaming === false ? 'old' : 'fresh'}>
                    <i className="dot" data-status={!stream.connected ? 'none' : streaming === false ? 'old' : 'fresh'} aria-hidden="true" />
                    {!stream.connected ? 'Not streaming right now' : streaming === false ? 'Osmosis moves are not streaming right now; Namada moves are' : page > 1 ? 'New moves are added to the first page as they are recorded' : 'New moves appear as they are recorded'}
                  </span>
                ) : null}
              </>
            )}
          </p>
          <div className="act-head__end">
            {wide ? csv : null}
            {pager('head')}
          </div>
        </div>
        {fresh ? (
          <PageTools
            className="act-tools"
            size={size}
            sizes={PAGE_SIZES}
            onSize={onSize}
            jump={{ label: 'Show moves from before', kind: 'date', button: 'Show', max: today, value: before != null ? isoDay(before) : '', onJump: goBefore }}
            after={<KeysHint />}
          >
            {wide ? null : csv}
          </PageTools>
        ) : null}
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
          <div className="act-txwide" ref={listRef}>
            <TxList rows={busy ? data.flows : rows} now={now} streamedIds={rewound || dated || page > 1 ? undefined : streamedIds} onAddr={openAddress} busy={busy} />
          </div>
        )}

        {empty ? (
          <EmptyState title={dated ? 'Nothing that early is recorded for these filters.' : 'No recorded move matches these filters.'}>
            {dated && before != null ? <>The list holds moves before {fmtDayMonthYear(before)} (UTC). </> : rewound && at ? <>The list holds moves at or before {fmtUtcLong(at)}. </> : null}
            The chain, kind, size and search chosen above leave nothing to show.
          </EmptyState>
        ) : null}

        {data && !empty ? <div className="act-foot">{pager('foot')}</div> : null}

        {scope.length ? <SourceLine items={scope} label="Where the moves come from" /> : <p className="src act-src-ph" aria-hidden="true" />}
      </ProvScope>
    </>
  );
}
