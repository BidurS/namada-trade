// Activity, Transactions tab (system.md 9.5): every recorded move of NAM, newest first.
//
// Rows (phones): line 1 the kind tag and the signed NAM; line 2 from → to, age and the dollar
// value; a disclosure opens line 3, "time and price source" with the record link. From a 880 px
// container the same cells line up as a table (Time, What, NAM, Value, From and to, Source,
// Record) with the column heads sticky under the header.
//
// State: the URL (urlState.ts: ?chain ?what ?min ?bots ?crossings ?q ?since ?before ?cursor ?page ?size),
// nav-search-plan 2.4. The search field reads the grammar into chips ("sell >100k last 7 days").
//
// Data: GET /api/flows with every filter the API takes (chain, kind or kind group, minimum NAM, bot trades left out,
// each bridge crossing once, since, an address start, a record start, a block, free text). A page reached by "›" is
// read by the server's position (`before`=FlowsResponse.next, an index seek); a typed page or Last by its number (an
// offset). The server counts the moves only on a page without a position, so the count is kept here per query
// (urlState.ts positions). "Show moves from before" reads the list through the same `at` the API takes for Rewind
// (rows at or before that time), which every server version understands. Under Rewind the shell's fetch wrapper adds
// `at` and nothing is streamed. While live, moves that arrive through the stream are merged on top of the first page.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Flow } from '../../../../shared/types';
import { fetchFlowsPage, flowsCsvHref, type FlowsCursorQuery } from '../../api';
import { navigate, osmosisStreaming, streamStamp, useClock, useOverlays, useOverview, useReplay } from '../../app/index';
import { Button, EmptyState, Notice, Num, PageTools, Pager, ProvScope, Segmented, SelectChip, Skeleton, SourceLine, TxList, stepFor, type ScopeItem, type Stamp } from '../../ui';
import { FilterChips } from '../../ui/FilterChips';
import { useListKeys, type ListKey } from '../../app/keys';
import { kindInfo, type TagKind } from '../../lib/kinds';
import { applyFlowRules, isBot } from '../../lib/flows';
import { fmtAge, fmtCount, fmtDayMonthYear, fmtUtcClock, fmtUtcLong } from '../../lib/format';
import type { ParsedKind } from '../../../../shared/search-grammar';
import { ActivityBar, FilterPanel, FilterSet, KeysHint, ListSearch, useRovingRows } from './parts';
import { SEARCH_HINT, SEARCH_PLACEHOLDER } from './words';
import { FLOW_CSV_MAX as CSV_MAX, PAGE_SIZES, firstVisibleRow, focusFirstRow, focusRow, pageCount, pageOfRank, revealRow } from './paging';
import { MOVE_DEFAULT, hrefWith, liftMoves, movePatch, movesApplied, positionsOf, type MoveUrl } from './urlState';
import { noteOrigin } from './sheetOrigin';

/** A unix-ms time as the date field's yyyy-mm-dd (UTC). */
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

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
  { value: 'pos_balance', label: kw('posBalance') },
  { value: 'other', label: kw('bot') },
];
const GROUPS: Record<string, string[]> = { dex: ['buy', 'sell', 'lp_add', 'lp_remove'], ibc: ['ibc_in', 'ibc_out'] };
/** The sizes offered as presets (a size typed in the field, "sell >5k", is shown beside them). */
const SIZES = ['0', '1000', '10000', '100000'] as const;

/** What the list applies, as the server reads it (worker/src/flows-query.ts), for rows that arrive by stream. */
interface Applied {
  chain: MoveUrl['chain'];
  kind: string;
  search: string;
  addr: string | null;
  hash: string | null;
  height: number | null;
  since: number | null;
}
function matches(fl: Flow, f: Applied): boolean {
  if (f.chain !== 'all' && fl.chain !== f.chain) return false;
  if (f.kind !== 'all' && !(GROUPS[f.kind]?.includes(fl.kind) ?? (f.kind === 'other' ? isBot(fl) : fl.kind === f.kind))) return false;
  if (f.since != null && fl.ts < f.since) return false;
  if (f.addr && ![fl.from, fl.to].some((a) => !!a && a.startsWith(f.addr!))) return false;
  if (f.hash && !fl.txHash.toUpperCase().startsWith(f.hash)) return false;
  if (f.height != null && fl.height !== f.height) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    if (![fl.from, fl.to, fl.txHash].some((x) => x?.toLowerCase().includes(q))) return false;
  }
  return true;
}

/** The size, bot and crossing rules as the API takes them. */
const rulesOf = (e: MoveUrl) => ({ minNam: e.min ?? undefined, arb: e.noBots ? (false as const) : undefined, pairs: e.both ? undefined : ('one' as const) });

interface Loaded {
  key: string;
  flows: Flow[];
  /** the count of these filters: from this answer, or kept from the page that carried it; null when not known */
  total: number | null;
  /** more than this many match: an address start the server does not count past FEW_ROWS (FlowsResponse.totalOver); `total` is then null */
  over: number | null;
  page: number;
  size: number;
  cursor: string | null;
  /** false: `total` is not the count of these filters (an older server ignored one; rows filtered here) */
  exact: boolean;
  /** the server holds rows after this page */
  more: boolean;
  asOf: number | null;
  last: { ts: number } | null | undefined;
  firstTs: number | null;
  /** filters this server could not apply (the screen names them) */
  ignored: string[];
}

const IGNORED_WORD: Record<string, string> = { since: 'a start date', addr: 'an address start', hash: 'a record', height: 'a block' };

// ---------------------------------------------------------------- the tab
export default function Transactions({
  url,
  go,
  wide,
}: {
  url: MoveUrl;
  go: (patch: Partial<MoveUrl>, opts?: { replace?: boolean }) => void;
  wide: boolean;
}) {
  const { at, rewound } = useReplay();
  const now = useClock();
  const { overview, liveFlows, streamedIds, stream } = useOverview();
  const { openAddress } = useOverlays();
  const [sheet, setSheet] = useState(false);
  const { page, size, cursor } = url;

  // ---- what the URL and the text apply (relative words such as "last 7 days" are read against the moment typed)
  const typedAt = useMemo(() => Date.now(), [url.q]);
  const applied = useMemo(() => movesApplied(url, typedAt), [url, typedAt]);
  const eff = applied.eff;
  const kind = eff.what ?? 'all';
  const filters: Applied = { chain: eff.chain, kind, search: applied.search, addr: applied.addr, hash: applied.hash, height: applied.height, since: eff.since };

  // ---- ?before= reads the list as of the last moment before that day, through the same `at` the API takes for
  // Rewind (rows at or before that time); under Rewind the earlier of the two
  const before = eff.before;
  const until = before != null ? Math.min(before - 1, at ?? Infinity) : at;
  const dated = before != null && until !== at;
  const key = JSON.stringify([filters, rulesOf(eff), until, size]);
  const pos = positionsOf(key);

  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const q: FlowsCursorQuery = {
    asOf: until,
    chain: eff.chain,
    kind,
    search: applied.search,
    ...rulesOf(eff),
    since: eff.since,
    addr: applied.addr,
    hash: applied.hash,
    height: applied.height,
  };
  // a page after the first goes by the server's position when it is known (the URL's, or one seen this visit)
  const position = page > 1 ? cursor ?? pos.cursors.get(page) ?? null : null;
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    fetchFlowsPage({ ...q, page, limit: size, before: position }, { signal: ctl.signal })
      .then((r) => {
        if (ctl.signal.aborted) return;
        const p = positionsOf(key);
        if (r.total != null) {
          p.total = r.total;
          p.exact = r.exact;
          p.countedAt = r.asOf ?? Date.now();
        }
        if (position) p.cursors.set(page, position);
        if (r.cursorPaged && r.next) p.cursors.set(page + 1, r.next);
        if (r.firstTs !== undefined) p.firstTs = r.firstTs;
        const total = r.total ?? p.total;
        const exact = r.total != null ? r.exact : p.exact && r.exact;
        // an older server pages by number: more when its count says so; this one says it by `next`
        const more = r.cursorPaged ? r.next != null : page * size < (r.total ?? 0);
        // a position this server does not know is not a filter it ignored: it paged by number (always sent)
        setData({ key, flows: r.flows, total, over: r.totalOver ?? null, page, size, cursor: position, exact, more, asOf: r.asOf ?? null, last: r.last, firstTs: r.firstTs ?? p.firstTs, ignored: r.ignored.filter((k) => k !== 'before') });
      })
      .catch(() => {
        if (!ctl.signal.aborted) setError(page > 1 ? 'This page of moves could not be fetched from this site’s server.' : 'The list of moves could not be fetched from this site’s server.');
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, page, position, retry]);

  // ---- streamed moves on top (live only, the first page only, never the load-time seed, never under a date)
  // the same filters (any page): the count stays while another page loads
  const fresh = data?.key === key ? data : null;
  const head = page === 1 && !cursor;
  const rows = useMemo(() => {
    if (!fresh) return [];
    if (rewound || dated || fresh.page !== 1) return fresh.flows;
    const have = new Set(fresh.flows.map((x) => x.id));
    const newest = fresh.flows[0]?.ts ?? 0;
    const add = liveFlows.filter((x) => streamedIds.has(x.id) && !have.has(x.id) && x.ts >= newest && matches(x, filters));
    return add.length ? applyFlowRules([...add, ...fresh.flows], rulesOf(eff)) : fresh.flows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh, liveFlows, streamedIds, rewound, dated, key]);
  const added = fresh ? rows.length - fresh.flows.length : 0;
  const exact = fresh?.exact ?? true;
  // not exact: the count of these filters is not known, only the rows listed
  const total = fresh && fresh.total != null ? (exact ? fresh.total + Math.max(0, added) : rows.length) : null;
  const streaming = osmosisStreaming(stream, now);
  // the number of pages only when the count is exact; otherwise "of —" and the next page while the server has more
  const pages = fresh && exact && total != null ? pageCount(total, size) : null;
  const current = !!fresh && fresh.page === page && fresh.size === size && fresh.cursor === position;
  const past = current && pages != null && page > pages;
  /** The href of page n: by the server's position when it is known, else by number; page 1 is the head. */
  const pageHref = (n: number) => hrefWith(movePatch({ page: n, cursor: n > 1 ? pos.cursors.get(n) ?? null : null }));
  useEffect(() => {
    if (past && pages != null) navigate(pageHref(pages), { replace: true, scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (p.kind === 'first') {
        // no row to land on (a date jump or a page that holds nothing): the count line, which says so, never <body>
        if (!listRef.current?.querySelector('.tx')) return headRef.current?.querySelector<HTMLElement>('.act-count')?.focus();
        return focusFirstRow(headRef.current, listRef.current, '.tx');
      }
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
    const at1 = seen ? (page - 1) * size + seen.index + 1 : 1;
    pending.current = seen && seen.index > 0 ? { kind: 'pos', pos: at1 } : null;
    navigate(hrefWith(movePatch({ page: pageOfRank(at1, n), size: n as MoveUrl['size'], cursor: null })), { scroll: false });
  };

  // ---- filters: every change is a history entry and starts again from page 1; the text's filter words move first
  const typing = useRef(false);
  const set = (patch: Partial<MoveUrl>) => {
    typing.current = false;
    go({ ...liftMoves(url, typedAt), ...patch, page: 1, cursor: null });
  };
  const unchip = (patch: Partial<MoveUrl>) => {
    typing.current = false;
    go({ ...patch, page: 1, cursor: null });
  };
  const onType = (v: string) => {
    if (v === url.q) return;
    go({ q: v, page: 1, cursor: null }, { replace: typing.current });
    typing.current = true;
  };
  const onCommit = (v: string) => {
    const wasTyping = typing.current;
    typing.current = false;
    const lifted = liftMoves({ ...url, q: v }, Date.now());
    if (JSON.stringify(movePatch({ ...url, ...lifted })) === JSON.stringify(movePatch(url))) return;
    go({ ...lifted, page: 1, cursor: null }, { replace: wasTyping || v === url.q });
  };
  const focusSearch = () => (document.querySelector<HTMLInputElement>('main [data-list-search] input') ?? document.querySelector<HTMLButtonElement>('main .act-filterbtn'))?.focus();
  const clearAll = () => {
    typing.current = false;
    go({ ...MOVE_DEFAULT, size });
  };

  /** Show moves from before a day: the list as of the end of the day before (UTC), from its first page. */
  const today = isoDay(Date.now());
  const goBefore = (value: string) => {
    if (!value) {
      if (before == null) return 'Pick a day.';
      set({ before: null });
      return null;
    }
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (!Number.isFinite(ms)) return 'Pick a day, such as one from the calendar.';
    if (ms > Date.now()) return 'That day has not come yet; pick today or earlier.';
    pending.current = { kind: 'first' };
    set({ before: ms });
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
    if (eff.chain !== 'namada') scope.push({ label: 'Moves on Osmosis', p: overview.dex.coverage });
    if (eff.chain !== 'osmosis') scope.push({ label: 'Moves on Namada', p: overview.namada.coverage });
  }
  if (!rewound) scope.push({ label: 'New moves as they happen', p: streamStamp(stream, now) });
  // the flow index of a chain listed here fell behind: said once, with the oldest such check
  const covStale = overview ? scope.filter((s) => s.p && s.label.startsWith('Moves on') && s.p.status === 'stale').map((s) => s.p as Stamp) : [];
  const covAt = covStale.length ? Math.min(...covStale.map((p) => p.at ?? Infinity)) : null;

  const count = applied.count;
  const showLabel = total == null ? 'Show moves' : `Show ${exact ? '' : 'at least '}${fmtCount(total)} move${total === 1 ? '' : 's'}`;
  const sizeLabel = (n: string) => (n === '0' ? 'Any' : `${fmtCount(Number(n))}+`);
  const sizeNow = eff.min ? String(eff.min) : '0';
  const sizeOptions = [...SIZES, ...((SIZES as readonly string[]).includes(sizeNow) ? [] : [sizeNow])].map((v) => ({ value: v, label: sizeLabel(v) }));
  const kindOptions = KIND_OPTIONS.some((o) => o.value === kind) ? KIND_OPTIONS : [...KIND_OPTIONS, { value: kind, label: kind }];

  const search = (compact: boolean) => (
    <ListSearch
      label="Search moves by address or record"
      compact={compact}
      value={url.q}
      onType={onType}
      onCommit={onCommit}
      placeholder={compact ? SEARCH_PLACEHOLDER.moves : 'tnam1…, osmo1…, a record or sell >100k'}
      hint={compact ? undefined : SEARCH_HINT.moves}
    />
  );
  const controls = (
    <>
      <FilterSet label="Chain">
        <Segmented label="Chain" value={eff.chain} onChange={(v) => set({ chain: v })} options={[{ value: 'all', label: 'Both' }, { value: 'namada', label: 'Namada' }, { value: 'osmosis', label: 'Osmosis' }]} />
      </FilterSet>
      <FilterSet label="Size, NAM">
        <Segmented label="Size, NAM" value={sizeNow} onChange={(v) => set({ min: Number(v) || null })} options={sizeOptions} />
      </FilterSet>
      <SelectChip label="What" className="act-kinds" value={kind} onChange={(v) => set({ what: v === 'all' ? null : (v as ParsedKind) })} options={kindOptions} />
      <FilterSet label="Bot trades" className="act-fset--opt">
        <Segmented label="Bot trades" value={eff.noBots ? 'hide' : 'show'} onChange={(v) => set({ noBots: v === 'hide' })} options={[{ value: 'show', label: 'Shown' }, { value: 'hide', label: 'Left out' }]} />
      </FilterSet>
      <FilterSet label="Bridge crossings" className="act-fset--opt">
        <Segmented label="Bridge crossings" value={eff.both ? 'both' : 'one'} onChange={(v) => set({ both: v === 'both' })} options={[{ value: 'one', label: 'Once' }, { value: 'both', label: 'Both records' }]} />
      </FilterSet>
      {wide ? null : search(false)}
      {count ? (
        <Button variant="secondary" size="sm" className="act-clear" onClick={clearAll}>
          Clear filters
        </Button>
      ) : null}
    </>
  );

  const busy = !!data && (data.key !== key || !current || past);
  const csv =
    fresh && ((total ?? 0) > 0 || (total == null && rows.length > 0)) ? (
      <a className="link act-csv" href={flowsCsvHref(q)} download>
        <span>Download page data</span>
        {/* the export holds at most the newest CSV_MAX moves (worker/src/api.ts /api/export/flows) */}
        <span className="act-csv__n">{!exact || total == null || fresh.over != null || total > CSV_MAX ? `CSV, newest ${fmtCount(CSV_MAX)}` : 'CSV, all of them'}</span>
      </a>
    ) : null;
  const empty = !!fresh && !busy && rows.length === 0;
  /** Behind a position the server does not count; a count seen this visit is kept, else the pages are "of —". */
  const unknownWhy = fresh && fresh.over != null ? `The number of pages is not known: more than ${fmtCount(fresh.over)} moves match this address start, and this site’s server does not count past that. Type the whole address to count its moves.` : fresh && fresh.total == null && applied.search ? 'The number of pages is not known: a search by text is not counted, so only the next page is offered.' : fresh && fresh.total == null ? 'The number of pages is not known: this site’s server counts the moves only on the first page of a list, and this page was opened from its own link. Open the first page to count them.' : 'The number of pages is not known: this site’s server did not count the moves these filters select, so only the next page is offered.';
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
        unknown={where === 'foot' ? unknownWhy : undefined}
      />
    ) : (
      <div className="pager act-pager act-pager--ph" aria-hidden="true" />
    );

  // ---- the address sheet says where it was opened from ("From activity · Move 51 of 53,934")
  const offset = (page - 1) * size;
  const onAddr = (a: string, f: Flow) => {
    const i = rows.findIndex((x) => x.id === f.id);
    const stamp = overview ? (f.chain === 'osmosis' ? overview.dex.coverage : overview.namada.coverage) : null;
    if (i >= 0) noteOrigin(a, { from: 'activity', pos: offset + i + 1, total, exact, stamp });
    openAddress(a);
  };
  const first = offset + 1;
  const lastRow = offset + rows.length;
  /** The newest move that matches every filter but the time window: "Rewind to it" drops that window. */
  const lastHref = fresh?.last ? hrefWith({ ...movePatch({ ...liftMoves(url, typedAt), since: null, before: null, cursor: null, page: 1 }), at: String(fresh.last.ts) }) : null;
  const beforeIndex = dated && before != null && fresh?.firstTs != null && before <= fresh.firstTs;

  return (
    <>
      <ActivityBar view="activity" wide={wide} filterCount={count} filterOpen={sheet} onFilter={() => setSheet(true)} search={wide ? search(true) : null} />
      <FilterPanel wide={wide} open={sheet} onClose={() => setSheet(false)} title="Filter moves" show={showLabel}>
        {controls}
      </FilterPanel>

      <ProvScope className="act-scope" id="act-tx-scope" aria-busy={busy || !data || undefined}>
        <div className="act-head" ref={headRef}>
          <p className="act-count" aria-live="polite" tabIndex={-1}>
            {!fresh ? (
              <span className="skel__b act-count__sk" aria-hidden="true" />
            ) : !exact ? (
              <>
                {rows.length ? (
                  <>
                    <Num v={rows.length} fmt={fmtCount} /> {rows.length === 1 ? 'move on this page matches' : 'moves on this page match'} the filters
                  </>
                ) : (
                  'No move on this page matches the filters'
                )}
                {dated && before != null ? <>, before {fmtDayMonthYear(before)} (UTC)</> : rewound && at ? <>, at or before {fmtUtcLong(at)}</> : null}, newest first; this site’s server could not apply every filter, so the moves were not counted.
              </>
            ) : total == null && fresh.over != null ? (
              <>
                More than <Num v={fresh.over} fmt={fmtCount} /> moves found that match the filters
                {dated && before != null ? <>, before {fmtDayMonthYear(before)} (UTC)</> : rewound && at ? <>, at or before {fmtUtcLong(at)}</> : null}, newest first
                {fresh.asOf != null && !rewound && !dated ? <> · <span className="act-at">read at {fmtUtcClock(fresh.asOf)}</span></> : null}
                .
              </>
            ) : total == null ? (
              <>
                Moves {rows.length ? <><Num v={first} fmt={fmtCount} /> to <Num v={lastRow} fmt={fmtCount} /></> : null}
                {count ? ' that match the filters' : null}
                {dated && before != null ? <>, before {fmtDayMonthYear(before)} (UTC)</> : rewound && at ? <>, at or before {fmtUtcLong(at)}</> : null}, newest first
                {fresh.asOf != null && !rewound && !dated ? <> · <span className="act-at">read at {fmtUtcClock(fresh.asOf)}</span></> : null}
                .
              </>
            ) : (
              <>
                A total of {exact ? null : 'at least '}
                <Num v={total} fmt={fmtCount} /> {total === 1 ? 'move' : 'moves'} found
                {count ? (total === 1 ? ' that matches the filters' : ' that match the filters') : null}
                {dated && before != null ? <>, before {fmtDayMonthYear(before)} (UTC)</> : rewound && at ? <>, at or before {fmtUtcLong(at)}</> : null}, newest first
                {fresh.asOf != null && !rewound && !dated ? <> · <span className="act-at">read at {fmtUtcClock(fresh.asOf)}</span></> : null}
                .
                {dated ? (
                  <>
                    {' '}
                    <a className="link act-newest" href={hrefWith(movePatch({ before: null, page: 1, cursor: null }))}>
                      Show the newest
                    </a>
                  </>
                ) : null}
                {!rewound && !dated ? (
                  <span className="act-live" data-status={!stream.connected ? 'none' : streaming === false ? 'old' : 'fresh'}>
                    <i className="dot" data-status={!stream.connected ? 'none' : streaming === false ? 'old' : 'fresh'} aria-hidden="true" />
                    {!stream.connected ? 'Not streaming right now' : streaming === false ? 'Osmosis moves are not streaming right now; Namada moves are' : !head ? 'New moves are added to the first page as they are recorded' : 'New moves appear as they are recorded'}
                  </span>
                ) : null}
              </>
            )}
          </p>
          <div className="act-head__end">
            {wide ? csv : null}
            {pager('head')}
          </div>
          <FilterChips
            className="act-chips"
            label="Filters on the list of moves"
            chips={applied.chips.map((c) => ({ key: c.key, label: c.label, note: c.note, applied: c.applied, onRemove: () => unchip(c.remove) }))}
            onClear={clearAll}
            onEmpty={focusSearch}
          />
        </div>
        {/* kept while the next page loads (its size, date and the URL's values do not wait for it), so the control a
            reader just used keeps focus */}
        {data ? (
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
        {fresh && fresh.ignored.length ? (
          <p className="scope__old act-lag">
            <i className="dot" data-status="old" aria-hidden="true" />
            <span>
              This site’s server cannot filter by {fresh.ignored.map((k) => IGNORED_WORD[k] ?? k).join(' or ')} yet, so only the moves on this page were checked for it; other pages may hold more.
            </span>
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
            <TxList
              rows={busy ? data.flows : rows}
              now={now}
              streamedIds={rewound || dated || !head ? undefined : streamedIds}
              onAddr={onAddr}
              busy={busy}
              total={exact ? total : null}
              offset={busy ? (data.page - 1) * data.size : offset}
            />
          </div>
        )}

        {empty ? (
          beforeIndex && fresh?.firstTs != null ? (
            <EmptyState title="Nothing that early is recorded.">
              The flow index starts on {fmtDayMonthYear(fresh.firstTs)} (UTC); the list holds no move before {fmtDayMonthYear(before!)}.
            </EmptyState>
          ) : !exact ? (
            <EmptyState title="No move on this page matches these filters.">
              This site’s server could not apply every filter, so only this page of moves was checked{fresh?.more ? '; the next page may hold some' : ''}.
            </EmptyState>
          ) : (
            <EmptyState title={dated ? 'Nothing that early is recorded for these filters.' : 'No recorded move matches these filters.'}>
              {dated && before != null ? <>The list holds moves before {fmtDayMonthYear(before)} (UTC). </> : rewound && at ? <>The list holds moves at or before {fmtUtcLong(at)}. </> : null}
              The chain, kind, size and search chosen above leave nothing to show.
              {fresh?.last && lastHref ? (
                <>
                  {' '}
                  The last one was {fmtAge(Date.now() - fresh.last.ts)} ago.{' '}
                  <a className="link act-newest" href={lastHref}>
                    Rewind to it
                  </a>
                </>
              ) : fresh?.last === null && head ? <> None is recorded at any time.</> : null}
            </EmptyState>
          )
        ) : null}

        {data && !empty ? <div className="act-foot">{pager('foot')}</div> : null}

        {scope.length ? <SourceLine items={scope} label="Where the moves come from" /> : <p className="src act-src-ph" aria-hidden="true" />}
      </ProvScope>
    </>
  );
}
