// Activity, Holders tab (system.md 9.5, reference final/holders.html): the biggest NAM holders.
//
// Rows: the two-line holder rows of Home with a hairline share bar; Spendable and Staked columns
// from a 930 px container; the 7-day column only when any value is not zero (otherwise said once).
// Provenance: the list is one scope with one SourceLine. When every balance is old the list is
// dimmed once and says so in one sentence; a row that differs carries its own mark (the server's
// status, owner decision 7: `conflict` shows both staked readings).
//
// State: the URL (urlState.ts: ?chain ?by ?what ?q ?min ?max ?page ?size), nav-search-plan 2.4. The search field reads
// the grammar (shared/search-grammar.ts) into chips; the filter words move into their parameters on Enter.
//
// Data: GET /api/holders (chain, sort, category, search, sizes, page). On the stored-totals server the answer carries
// the count and the "What" counts over the whole list (kv holders.counts, `countsAt`) and the time of the order
// (`asOf`); an older server sends neither, and the client says what it counted instead (api.ts fetchHoldersPage).
// It does not take `at`: under Rewind the list is current and says so ("Balances were not recorded over time; these
// are current, not as of …").
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Holder, Overview, SourceStatus } from '../../../../shared/types';
import { fetchHoldersPage, holdersCsvHref, type HoldersPage } from '../../api';
import { REWIND_WORDS, navigate, useNow, useOverlays, useReplay } from '../../app/index';
import { Button, DataList, EmptyState, HolderRow, Notice, Num, PageTools, Pager, ProvDot, Segmented, SelectChip, Skeleton, SourceLine, Tag, WallClock, sourcesText, stepFor, type ScopeItem, type Stamp } from '../../ui';
import { FilterChips } from '../../ui/FilterChips';
import type { Column } from '../../ui/DataList';
import { useListKeys, type ListKey } from '../../app/keys';
import { ageRange } from '../../lib/prov';
import { holderCatKey as catKey, holderName, holderTag, isUserTag } from '../../lib/holder';
import { category_plain } from '../../../../shared/labels';
import { fmtAddr, fmtAge, fmtCount, fmtNamRule, fmtNamSigned, fmtPctRule, fmtUtcClock } from '../../lib/format';
import { ActivityBar, FilterPanel, FilterSet, KeysHint, ListSearch, useRovingRows } from './parts';
import { HOLDER_SEARCH_EMPTY, SEARCH_HINT, SEARCH_PLACEHOLDER, TECH } from './words';
import { HOLDER_CSV_MAX, PAGE_SIZES, firstVisibleRow, flashRow, focusFirstRow, focusRow, pageCount, pageOfRank, revealRow } from './paging';
import { HOLDER_DEFAULT, SORT_API, holderPatch, holdersApplied, hrefWith, liftHolders, type HolderUrl } from './urlState';
import { noteOrigin } from './sheetOrigin';

const H6 = 6 * 3_600_000;
const H24 = 24 * 3_600_000;
/** The counts the cron keeps are rewritten after each listing and every 10 minutes: older than an hour, they are old. */
const COUNTS_OLD_MS = 3_600_000;
const BY_WORD: Record<HolderUrl['by'], string> = { total: 'total NAM', spendable: 'spendable NAM', staked: 'staked NAM' };
const CHAIN_WORD: Record<HolderUrl['chain'], string> = { namada: 'on Namada', osmosis: 'on Osmosis', all: 'on Namada and Osmosis' };

/** The widest rank on the page, in characters of the rank's mono face ("1,204" is 5). */
const rkChars = (ranks: number[]): number => Math.max(0, ...ranks.map((r) => fmtCount(r).length));
/** One character of the rank's 12 px mono face, in px (0.6 em, plus a little room). */
const RK_CH_PX = 7.6;

const statusOf = (h: Holder): { status: SourceStatus; note: string | null } => ({ status: h.status, note: h.statusNote ?? null });

type CatCounts = NonNullable<HoldersPage['categories']>;

interface Loaded {
  key: string;
  rows: Holder[];
  /** null: more than `over` match a size range, and the server did not count further */
  total: number | null;
  /** HoldersResponse.totalOver: the count's bound when `total` is null */
  over: number | null;
  /** the server holds rows after this page (HoldersResponse.next) */
  more: boolean;
  page: number;
  size: number;
  /** the server's "What" counts over the whole list (null on servers before the stored totals) */
  cats: CatCounts | null;
  /** when the order was read, and when the count was taken (null: counted for this search); both absent on older servers */
  asOf: number | null;
  countsAt: number | null;
  /** false: the server ignored a size filter, applied here to these rows only */
  exact: boolean;
}

export default function Holders({
  url,
  go,
  wide,
  overview,
}: {
  /** The list's state, from the URL. */
  url: HolderUrl;
  /** Write a change to the URL (a history entry unless `replace`). */
  go: (patch: Partial<HolderUrl>, opts?: { replace?: boolean }) => void;
  wide: boolean;
  overview: Overview | null;
}) {
  const { at, rewound } = useReplay();
  const wall = useNow(); // balances are current: their ages are measured from the wall clock, also under Rewind
  const { openAddress } = useOverlays();
  const [sheet, setSheet] = useState(false);
  const { page, size } = url;

  // ---- what the URL and the text apply (the text's relative words are read against the moment it was typed)
  const typedAt = useMemo(() => Date.now(), [url.q]);
  const applied = useMemo(() => holdersApplied(url, typedAt), [url, typedAt]);
  const eff = applied.eff;
  const sort = eff.chain === 'osmosis' ? 'total' : eff.by;
  const by = SORT_API[sort];
  const category = eff.what ?? '';
  const search = applied.search;
  const key = JSON.stringify([eff.chain, by, search, category, eff.min, eff.max]);

  // ---- the page from the URL; a page change replaces the rows
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    fetchHoldersPage({ chain: eff.chain, by, category, search, min: eff.min, max: eff.max, page, limit: size }, { signal: ctl.signal })
      .then((r) => {
        if (ctl.signal.aborted) return;
        setData({ key, rows: r.holders, total: r.total, over: r.totalOver ?? null, more: r.next != null, page, size, cats: r.categories ?? null, asOf: r.asOf ?? null, countsAt: r.countsAt ?? null, exact: r.exact });
      })
      .catch(() => {
        if (!ctl.signal.aborted) setError(page > 1 ? 'This page of holders could not be fetched from this site’s server.' : 'The holder list could not be fetched from this site’s server.');
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, page, size, retry]);
  // the same query (any page, any size): the count and the chips stay while another page loads
  const fresh = data?.key === key ? data : null;
  const loaded = fresh?.rows ?? [];
  // not known when more holders match than the server counts (`over`): "of —", and the next page while it has more
  const pages = fresh && fresh.total != null ? pageCount(fresh.total, size) : null;
  /** The rows on screen are the ones the URL asks for. */
  const current = !!fresh && fresh.page === page && fresh.size === size;
  // a page past the end (an old link, a list that shrank): the last page, without a history entry
  const past = current && pages != null && page > pages;
  useEffect(() => {
    if (past && pages != null) go({ page: pages }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [past, pages]);
  const pageHref = (n: number) => hrefWith(holderPatch({ page: n }));

  // ---- the order was refreshed between two pages of the same query (the counts were taken again): said once
  const baseline = useRef<{ key: string; countsAt: number } | null>(null);
  const [refreshed, setRefreshed] = useState<number | null>(null);
  useEffect(() => {
    if (!fresh || !current || fresh.countsAt == null) return;
    const b = baseline.current;
    if (!b || b.key !== key || page === 1) {
      baseline.current = { key, countsAt: fresh.countsAt };
      setRefreshed(null);
    } else if (fresh.countsAt !== b.countsAt) setRefreshed(fresh.countsAt);
  }, [fresh, current, key, page]);

  // ---- after a page change, once the rows are in: the first row focused (a pager link, a key), or a rank
  // reached (Go to rank: scrolled under the sticky stack, focused, highlighted; a size change: kept in view)
  const headRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ kind: 'first' } | { kind: 'rank'; rank: number; focus: boolean } | null>(null);
  /** The row of a rank among the rows on screen (its rank cell says it). */
  const rowOfRank = (rank: number): HTMLElement | null => {
    const rows = [...(listRef.current?.querySelectorAll<HTMLElement>('.hrow') ?? [])];
    const want = fmtCount(rank);
    const guess = rows[rank - (page - 1) * size - 1];
    if (guess?.querySelector('.hrow__rk')?.textContent === want) return guess;
    return rows.find((r) => r.querySelector('.hrow__rk')?.textContent === want) ?? null;
  };
  const reachRank = (rank: number, focus: boolean) => {
    const row = rowOfRank(rank);
    if (!row) return;
    revealRow(row, headRef.current, listRef.current, 'top');
    if (focus) {
      focusRow(row, listRef.current, '.hrow');
      flashRow(row);
    }
  };
  useEffect(() => {
    const p = pending.current;
    if (!p || !current || !data || data.key !== key) return;
    pending.current = null;
    requestAnimationFrame(() => {
      if (p.kind === 'first') focusFirstRow(headRef.current, listRef.current, '.hrow');
      else reachRank(p.rank, p.focus);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, key, current]);
  const onGo = () => {
    pending.current = { kind: 'first' };
    focusFirstRow(headRef.current, listRef.current, '.hrow', false);
  };
  const goPage = (n: number) => {
    onGo();
    navigate(pageHref(n), { scroll: false });
  };

  /** Go to rank: the page that holds it (page = ceil(rank / size)), that row in view, focused and highlighted. */
  const goRank = (value: string) => {
    const t = value.replace(/[,\s]/g, '');
    if (!/^\d+$/.test(t) || Number(t) < 1) return 'Type a rank as a whole number, as printed at the start of each row.';
    const rank = Number(t);
    if (fresh && fresh.total != null && rank > fresh.total) {
      return fresh.total === 1 ? (
        <>There is only one holder here; pick that rank.</>
      ) : (
        <>
          There are <Num v={fresh.total} fmt={fmtCount} /> holders; pick a rank up to that.
        </>
      );
    }
    const to = pageOfRank(rank, size);
    if (to === page && current) reachRank(rank, true);
    else {
      pending.current = { kind: 'rank', rank, focus: true };
      navigate(pageHref(to), { scroll: false });
    }
    return null;
  };

  /** Rows per page: a history entry; the page that holds the first row in view, kept in view. */
  const onSize = (n: number) => {
    if (n === size) return;
    const seen = firstVisibleRow(headRef.current, listRef.current, '.hrow');
    const rank = seen ? (busy ? data?.rows : rows)?.[seen.index]?.rank ?? null : null;
    const to = rank ? pageOfRank(rank, n) : 1;
    pending.current = rank && seen && seen.index > 0 ? { kind: 'rank', rank, focus: false } : null;
    navigate(hrefWith(holderPatch({ page: to, size: n as HolderUrl['size'] })), { scroll: false });
  };

  // ---- keys (app/keys.ts): j and k walk the rows, Enter opens the row's address, [ and ] change the page
  useRovingRows(listRef, '.hrow', data);
  useListKeys('.act-holders .hrow', (a: ListKey, row) => {
    const list = listRef.current;
    if (!list) return false;
    if (a.kind === 'page') {
      const to = stepFor(a.step < 0 ? '[' : ']', page, pages);
      if (to == null) return false;
      goPage(to);
      return true;
    }
    if (a.kind === 'open') {
      row?.querySelector<HTMLButtonElement>('.act-name')?.click();
      return !!row;
    }
    const all = [...list.querySelectorAll<HTMLElement>('.hrow')];
    if (!all.length) return false;
    let to: HTMLElement | undefined;
    if (a.kind === 'edge') to = a.to === 'first' ? all[0] : all[all.length - 1];
    else if (row) to = all[all.indexOf(row) + a.step];
    else to = firstVisibleRow(headRef.current, list, '.hrow')?.row ?? all[0];
    if (!to) return true;
    revealRow(to, headRef.current, list);
    focusRow(to, list, '.hrow');
    return true;
  });

  // ---- the "What" chips, with counts (kept while a category is chosen, so the other chips stay).
  // A server that sends HoldersResponse.categories counts every holder the chain, size and search select, so a chip's
  // count is the number of holders choosing it lists. An older server sends none: then the chips count the biggest
  // holders loaded without a category filter, and the legend says so. The server filters by category (?category=);
  // a server that predates that returns every category, and the loaded rows are filtered here.
  const [catRows, setCatRows] = useState<{ base: string; rows: Holder[]; server: CatCounts | null } | null>(null);
  const baseKey = JSON.stringify([eff.chain, by, search, eff.min, eff.max]);
  useEffect(() => {
    if (!fresh) return;
    // the server's counts leave the category out, so any answer for this chain and search carries them
    if (fresh.cats) setCatRows({ base: baseKey, rows: [], server: fresh.cats });
    // an older server: the chips count the biggest holders, page 1 of the list without a category
    else if (!eff.what && fresh.page === 1) setCatRows({ base: baseKey, rows: loaded, server: null });
  }, [fresh, eff.what, baseKey, loaded]);
  const cats = useMemo(() => {
    // the answer on screen carries the server's counts: they are used in the render that draws its rows, so the chips
    // never count the loaded rows for one frame first (a narrower set that then grows and moves the list down)
    const mine = fresh?.cats ? { base: baseKey, rows: [], server: fresh.cats } : catRows?.base === baseKey ? catRows : null;
    const m = new Map<string, { label: string; n: number }>();
    const word = (k: string, plain?: string | null) => (k === 'none' ? 'No label' : plain ?? category_plain(k) ?? k);
    let allN: number;
    let whole = false;
    if (mine?.server) {
      whole = true;
      allN = mine.server.total;
      for (const c of mine.server.counts) if (c.n > 0) m.set(c.category, { label: word(c.category), n: c.n });
    } else {
      const src = mine ? mine.rows : !eff.what && fresh?.page === 1 ? loaded : [];
      allN = src.length;
      for (const h of src) {
        const k = catKey(h);
        const e = m.get(k) ?? { label: word(k, h.category_plain), n: 0 };
        e.n += 1;
        m.set(k, e);
      }
    }
    const list = [...m.entries()].sort((a, b) => (a[0] === 'none' ? 1 : b[0] === 'none' ? -1 : b[1].n - a[1].n));
    if (eff.what && !m.has(eff.what)) list.push([eff.what, { label: word(eff.what), n: 0 }]);
    return { list, allN, whole };
  }, [catRows, baseKey, loaded, eff.what, fresh?.page, fresh?.cats]);
  /** The chip legend: plain "What" when the counts cover every holder, else what they count. */
  const catLegend = cats.whole || !cats.allN ? 'What' : `What, counted among the ${fmtCount(cats.allN)} biggest loaded`;
  const serverFiltered = !eff.what || loaded.every((h) => catKey(h) === eff.what);
  const rows = serverFiltered ? loaded : loaded.filter((h) => catKey(h) === eff.what);

  // ---- status: whole list old (dim once, one sentence) or rows that differ (own mark)
  const st = useMemo(() => new Map(loaded.map((h) => [h.chain + h.address, statusOf(h)])), [loaded]);
  const stOf = (h: Holder) => st.get(h.chain + h.address) ?? { status: 'live' as SourceStatus, note: null };
  const allStale = rows.length > 0 && rows.every((h) => stOf(h).status === 'stale');
  const checked = rows.map((h) => h.verifiedAt).filter((v): v is number => v != null);
  const checkRange = checked.length ? ageRange(checked.map((a) => ({ source: '', at: a, status: 'live' as const })), wall) : null;
  const oldWords = allStale
    ? checkRange
      ? `Balances were last checked ${checkRange === 'just now' ? 'just now' : `${checkRange} ago`}, so they are shown dimmed.`
      : 'These balances have not been checked on chain yet, so they are shown dimmed.'
    : null;
  const listOld = rewound || allStale;
  const oldSentence = rewound && at ? <>{REWIND_WORDS.balances(at)}{oldWords ? ` ${oldWords.replace(', so they are shown dimmed', '')}` : ''}</> : oldWords;

  // ---- 7-day changes: a column only when any value is not zero; otherwise one sentence
  const ch = rows.map((h) => h.change7d);
  const anyChange = ch.some((v) => v != null && v !== 0);
  const unknown7 = ch.filter((v) => v == null).length;
  const sentence7 = !rows.length || anyChange
    ? unknown7 && anyChange ? `The 7-day change is not known for ${fmtCount(unknown7)} of these balances.` : null
    : unknown7 === rows.length ? 'Changes over 7 days are not known yet for these balances.'
    : unknown7 ? `No balance with a reading from 7 days ago changed since then; ${fmtCount(unknown7)} have no reading that old.`
    : 'No balance here changed in the last 7 days.';

  // ---- the order and the count: when the list was read and when it was counted (a server with the stored totals)
  const countAt = fresh ? fresh.countsAt ?? fresh.asOf : null;
  const countStamp: Stamp | null =
    fresh && countAt != null
      ? {
          source: TECH.holderIndex,
          plain: 'Holder index',
          at: countAt,
          status: wall - countAt > COUNTS_OLD_MS ? 'stale' : 'live',
          note: fresh.countsAt == null ? 'Counted for this search when the list was read.' : 'Counted over the stored balances after the last balance listing; the order and the ranks are as of the time the list was read.',
        }
      : null;
  const orderStamp: Stamp | null = fresh?.asOf != null ? { source: TECH.holderIndex, plain: 'Holder index', at: fresh.asOf, status: 'live', note: 'The order of the stored balances when the list was read.' } : null;

  // ---- the list's scope (one SourceLine)
  const scope: ScopeItem[] = [];
  if (countStamp) scope.push({ label: 'Holder count and order', p: countStamp });
  for (const chain of ['namada', 'osmosis'] as const) {
    const part = rows.filter((h) => h.chain === chain);
    const ats = part.map((h) => h.verifiedAt).filter((v): v is number => v != null);
    if (!part.length) continue;
    const src = chain === 'namada' ? { source: TECH.namadaBalances } : { source: TECH.osmosisBalances, plain: 'Osmosis chain' };
    const note = rewound && at ? REWIND_WORDS.balances(at) : undefined;
    const oldest = ats.length ? Math.min(...ats) : null;
    const newest = ats.length ? Math.max(...ats) : null;
    const word = chain === 'namada' ? 'Namada' : 'Osmosis';
    scope.push({ label: `Spendable balances on ${word}, newest check`, p: { ...src, at: newest, status: newest == null ? 'missing' : wall - newest > H6 || rewound ? 'stale' : 'live', note } });
    scope.push({ label: `Spendable balances on ${word}, oldest check`, p: { ...src, at: oldest, status: oldest == null || part.some((h) => h.verifiedAt == null) ? 'stale' : wall - oldest > H6 || rewound ? 'stale' : 'live', note: note ?? (part.some((h) => h.verifiedAt == null) ? 'Some balances have not been checked on chain yet.' : undefined) } });
    if (chain === 'namada') {
      const reads = part.map((h) => h.bondedVerifiedAt).filter((v): v is number => v != null);
      if (reads.length) {
        const o = Math.min(...reads);
        scope.push({ label: 'Staked amounts, oldest chain read', p: { source: TECH.namadaStakes, at: o, status: wall - o > H24 || rewound ? 'stale' : 'live', note } });
      }
    }
  }
  const scopeText = rewound ? ` · ${sourcesText(scope)} · current, not as of the rewound time` : undefined;

  // ---- filters: every change is a history entry and starts again from page 1; the text's filter words move first
  const typing = useRef(false);
  const set = (patch: Partial<HolderUrl>) => {
    typing.current = false;
    go({ ...liftHolders(url, typedAt), ...patch, page: 1 });
  };
  /** Typing: the text applies as it is; the first change of a search is a history entry, the rest replace it. */
  const onType = (v: string) => {
    if (v === url.q) return;
    go({ q: v, page: 1 }, { replace: typing.current });
    typing.current = true;
  };
  /** Enter, or leaving the field: the filter words become their own parameters (and chips). */
  const onCommit = (v: string) => {
    const wasTyping = typing.current;
    typing.current = false;
    const lifted = liftHolders({ ...url, q: v }, Date.now());
    const next = { ...url, ...lifted };
    if (JSON.stringify(holderPatch(next)) === JSON.stringify(holderPatch(url))) return;
    go({ ...lifted, page: 1 }, { replace: wasTyping || v === url.q });
  };
  /** A chip removed: exactly what it says (its word out of the text, or its parameter). */
  const unchip = (patch: Partial<HolderUrl>) => {
    typing.current = false;
    go({ ...patch, page: 1 });
  };
  /** After the last chip: focus goes to the search field, or (phones, where it is in the sheet) the Filter button. */
  const focusSearch = () => (document.querySelector<HTMLInputElement>('main [data-list-search] input') ?? document.querySelector<HTMLButtonElement>('main .act-filterbtn'))?.focus();
  const clearAll = () => {
    typing.current = false;
    go({ chain: HOLDER_DEFAULT.chain, by: HOLDER_DEFAULT.by, what: null, q: '', min: null, max: null, page: 1 });
  };
  /** The Filter button's badge counts the chips (the sort is not a filter: the count line says it). */
  const count = applied.count;
  const anyOn = count > 0 || (url.by !== HOLDER_DEFAULT.by && eff.chain !== 'osmosis');
  const shown = rows.length;
  const showN = serverFiltered && fresh ? fresh.total : shown;
  const showLabel = !fresh ? 'Show holders' : showN != null ? `Show ${fmtCount(showN)} holder${showN === 1 ? '' : 's'}` : fresh.over != null ? `Show more than ${fmtCount(fresh.over)} holders` : 'Show holders';
  const search$ = (compact: boolean) => (
    <ListSearch
      label="Search holders by address or name"
      compact={compact}
      value={url.q}
      onType={onType}
      onCommit={onCommit}
      placeholder={compact ? SEARCH_PLACEHOLDER.holders : 'tnam1…, osmo1…, …kj4m or a name'}
      hint={compact ? undefined : SEARCH_HINT.holders}
    />
  );
  const controls = (
    <>
      {/* Chain and Biggest by. From 1024 px, while both show, they are a row of their own: the What chips, whose number
          and counts come with the answer, are wider than the room beside them, so they start the next row from the first
          paint instead of moving there and pushing the list down when the answer lands. In the sheet the box is not drawn. */}
      <div className={`act-frow${eff.chain !== 'osmosis' && !search ? ' act-frow--by' : ''}`}>
        <FilterSet label="Chain">
          <Segmented label="Chain" value={eff.chain} onChange={(v) => set({ chain: v, what: null })} options={[{ value: 'namada', label: 'Namada' }, { value: 'osmosis', label: 'Osmosis' }, { value: 'all', label: 'Both' }]} />
        </FilterSet>
        {eff.chain !== 'osmosis' ? (
          <FilterSet label="Biggest by">
            <Segmented label="Biggest by" value={eff.by} onChange={(v) => set({ by: v })} options={[{ value: 'total', label: 'Total' }, { value: 'spendable', label: 'Spendable' }, { value: 'staked', label: 'Staked' }]} />
          </FilterSet>
        ) : null}
      </div>
      <SelectChip
        label={catLegend}
        className="act-cats"
        value={eff.what ?? 'all'}
        onChange={(v) => set({ what: v === 'all' ? null : v })}
        options={[{ value: 'all', label: 'All', count: cats.allN || null }, ...cats.list.map(([k, c]) => ({ value: k, label: c.label, count: c.n }))]}
      />
      {wide ? null : search$(false)}
      {anyOn ? (
        <Button variant="secondary" size="sm" className="act-clear" onClick={clearAll}>
          Clear filters
        </Button>
      ) : null}
    </>
  );

  const busy = !!data && (data.key !== key || data.page !== page || data.size !== size || past);
  // The share bars are relative to the largest total on the list's first page (its biggest holders), the same on
  // every page: page 40 must not look as heavy as page 1. Taken from a first page seen this visit; a deeper page
  // opened by its own link draws no bar until then, rather than one scaled to its own largest row.
  const pageTop = rows.length ? Math.max(...loaded.map((h) => h.total)) : 0;
  if (fresh && fresh.page === 1 && pageTop > 0) LIST_TOP.set(key, pageTop);
  const top = fresh && fresh.page === 1 ? pageTop : LIST_TOP.get(key) ?? 0;
  const full = eff.chain !== 'osmosis';
  const empty = !!fresh && !busy && rows.length === 0;
  /** The count covers the rows the filters select (a server that ignored a size filter: only this page was checked). */
  const exact = !!fresh && fresh.exact && serverFiltered;
  /** Some holders match: a count above 0, or more than the server counts. */
  const any = !!fresh && ((fresh.total ?? 0) > 0 || fresh.over != null);

  // ---- column heads on the desktop table: Total, Spendable and Staked sort the list (the "Biggest by" choice)
  const sortHead = (v: HolderUrl['by'], word: string) => (
    <button type="button" className={`dl__sort${sort === v ? ' is-on' : ''}`} data-sort={v} aria-label={`${word}, biggest first`} onClick={() => set({ by: v })}>
      <span className="dl__sorti" aria-hidden="true">↓</span>
      <span>{word}</span>
    </button>
  );
  const sorted = (v: HolderUrl['by']): Column['sort'] => (sort === v ? 'descending' : 'none');
  const columns: Column[] | undefined = full
    ? [
        { label: '#' },
        { label: 'Holder' },
        { label: sortHead('total', 'Total NAM'), align: 'r', sort: sorted('total') },
        { label: 'Share', align: 'r' },
        { label: sortHead('spendable', 'Spendable'), align: 'r', sort: sorted('spendable') },
        { label: sortHead('staked', 'Staked'), align: 'r', sort: sorted('staked') },
        ...(anyChange ? [{ label: '7 days', align: 'r' as const }] : []),
      ]
    : undefined;

  const csv =
    fresh && any ? (
      <a className="link act-csv" href={holdersCsvHref({ chain: eff.chain, by, category, search })} download>
        <span>Download page data</span>
        {/* the export holds the biggest HOLDER_CSV_MAX of these holders (worker/src/api.ts /api/export/holders) */}
        <span className="act-csv__n">{fresh.total == null || fresh.total > HOLDER_CSV_MAX ? `CSV, biggest ${fmtCount(HOLDER_CSV_MAX)}` : 'CSV, all of them'}</span>
      </a>
    ) : null;

  /** When the number of pages is not known (more holders match than the server counts): why, in one sentence. */
  const unknownWhy = fresh && fresh.over != null ? `The number of pages is not known: more than ${fmtCount(fresh.over)} holders match these filters, and this site’s server does not count past that.` : undefined;
  const pager = (where: 'head' | 'foot') =>
    fresh && (pages != null || fresh.over != null) ? (
      <Pager label={where === 'head' ? 'Holder pages' : 'Holder pages, under the list'} page={page} pages={pages} hasNext={fresh.more} hrefFor={pageHref} onGo={onGo} run={where === 'foot'} unknown={where === 'foot' ? unknownWhy : undefined} className={`act-pager act-pager--${where}`} />
    ) : (
      <div className="pager act-pager act-pager--ph" aria-hidden="true" />
    );

  /** A row's name: the sheet opens with where it came from ("From holders · No. 1,204 by total NAM"). */
  const onAddr = (h: Holder) => {
    noteOrigin(h.address, { from: 'holders', rank: h.rank, by, chain: eff.chain, stamp: orderStamp ?? countStamp });
    openAddress(h.address);
  };
  const whatWord = eff.what ? cats.list.find(([k]) => k === eff.what)?.[1].label ?? category_plain(eff.what) ?? eff.what : null;

  return (
    <>
      <ActivityBar view="holders" wide={wide} filterCount={count} filterOpen={sheet} onFilter={() => setSheet(true)} search={wide ? search$(true) : null} />
      <FilterPanel wide={wide} open={sheet} onClose={() => setSheet(false)} title="Filter holders" show={showLabel}>
        {controls}
      </FilterPanel>

      <WallClock>
      <div className="act-scope" id="act-h-scope" data-prov-scope="" aria-busy={busy || !data || undefined}>
        {sentence7 || (listOld && oldSentence) ? (
          <div className="act-sentence">
            {sentence7 ? <p>{sentence7}</p> : null}
            {listOld && oldSentence ? (
              <p className="scope__old">
                <i className="dot" data-status="old" aria-hidden="true" />
                <span>{oldSentence}</span>
              </p>
            ) : null}
          </div>
        ) : !fresh && !error ? (
          // until this list's rows are in, its sentence about the 7-day changes is not known: one line is held for it,
          // so the count line and the list do not move down when it lands
          <div className="act-sentence act-sentence--wait" aria-hidden="true" />
        ) : null}
        <div className="act-head" ref={headRef}>
          <p className="act-count" aria-live="polite">
            {!fresh ? (
              <span className="skel__b act-count__sk" aria-hidden="true" />
            ) : exact && fresh.total == null && fresh.over != null ? (
              <>
                More than <Num v={fresh.over} fmt={fmtCount} /> holders found {CHAIN_WORD[eff.chain]}
                {whatWord ? <> in “{whatWord}”</> : null}
                {search ? <> matching “{search}”</> : null}, biggest first by {BY_WORD[sort]}
                {fresh.asOf != null ? (
                  <>
                    {' '}
                    · <span className="act-at">ordered at {fmtUtcClock(fresh.asOf)}</span>
                  </>
                ) : null}
                .
              </>
            ) : exact ? (
              <>
                A total of <Num v={fresh.total} fmt={fmtCount} /> {fresh.total === 1 ? 'holder' : 'holders'} found {CHAIN_WORD[eff.chain]}
                {whatWord ? <> in “{whatWord}”</> : null}
                {search ? <> matching “{search}”</> : null}, biggest first by {BY_WORD[sort]}
                {fresh.asOf != null ? (
                  <>
                    {' '}
                    · <span className="act-at">ordered at {fmtUtcClock(fresh.asOf)}</span>
                  </>
                ) : null}
                .
              </>
            ) : !serverFiltered ? (
              <>
                <Num v={shown} fmt={fmtCount} /> of the <Num v={loaded.length} fmt={fmtCount} /> holders on this page match; a total of <Num v={fresh.total} fmt={fmtCount} /> holders found {CHAIN_WORD[eff.chain]}.
              </>
            ) : (
              <>
                <Num v={shown} fmt={fmtCount} /> of the <Num v={loaded.length} fmt={fmtCount} /> holders on this page are within the sizes asked; this site’s server does not filter holders by size yet, so the other pages were not checked. A total of <Num v={fresh.total} fmt={fmtCount} /> holders found {CHAIN_WORD[eff.chain]}.
              </>
            )}
          </p>
          <div className="act-head__end">
            {wide ? csv : null}
            {pager('head')}
          </div>
          <FilterChips
            className="act-chips"
            label="Filters on the holder list"
            chips={applied.chips.map((c) => ({ key: c.key, label: c.label, note: c.note, applied: c.applied, onRemove: () => unchip(c.remove) }))}
            onClear={clearAll}
            onEmpty={focusSearch}
          />
        </div>
        {any ? (
          <PageTools
            className="act-tools"
            size={size}
            sizes={PAGE_SIZES}
            onSize={onSize}
            jump={{ label: 'Go to rank', kind: 'number', button: 'Go', placeholder: 'Rank', onJump: goRank }}
            after={<KeysHint />}
          >
            {wide ? null : csv}
          </PageTools>
        ) : null}

        {refreshed != null ? (
          <Notice
            tone="info"
            title="The list was refreshed"
            action={
              <Button size="sm" onClick={() => goPage(1)}>
                Start from the top
              </Button>
            }
          >
            The holder list was counted again at {fmtUtcClock(refreshed)} while you were reading; this page and the ones after it are in the new order.
          </Notice>
        ) : null}

        {error && fresh ? (
          <Notice tone="warning" title="This page did not load" action={<Button size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>}>
            {error}
          </Notice>
        ) : null}
        {error && !fresh ? (
          <Notice tone="warning" title="The holders did not load" action={<Button size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>}>
            {error}
          </Notice>
        ) : !data ? (
          <Skeleton rows={8} heights={[64]} label="holders" className="act-skel" />
        ) : empty ? null : (
          <div className={busy ? 'is-busy' : undefined} ref={listRef} style={{ ['--act-rk' as string]: `${Math.ceil(rkChars((busy ? data.rows : rows).map((h) => h.rank)) * RK_CH_PX)}px` } as React.CSSProperties}>
            <DataList
              kind="holders"
              full={full}
              change={full && anyChange}
              columns={columns}
              label={`Biggest NAM holders ${CHAIN_WORD[eff.chain]}`}
              old={listOld}
              rowCount={exact && fresh && fresh.total != null ? fresh.total + 1 : undefined}
              className="act-holders"
            >
              {(busy ? data.rows : rows).map((h) => (
                <Row key={h.chain + h.address} h={h} s={stOf(h)} wall={wall} mixed={!listOld} top={top} anyChange={full && anyChange} both={eff.chain === 'all'} onAddr={onAddr} rowIndex={exact ? h.rank + 1 : undefined} />
              ))}
            </DataList>
          </div>
        )}

        {empty ? (
          eff.chain === 'osmosis' && !search && !eff.what && !eff.min && !eff.max ? (
            <EmptyState title="The Osmosis list was not captured.">
              {overview && overview.dex.holders != null && overview.dex.holders > 0 ? (
                <>
                  <Num v={overview.dex.holders} fmt={fmtCount} /> addresses hold NAM on Osmosis
                  {overview.concentration.osmosisTop10Pct != null ? <> and the top 10 own <Num v={overview.concentration.osmosisTop10Pct} fmt={(n) => fmtPctRule(n, 1)} /> of it</> : null}
                  , but the rows behind those figures did not come back.
                </>
              ) : (
                'No Osmosis holder rows came back from this site’s server.'
              )}
            </EmptyState>
          ) : eff.what && !serverFiltered ? (
            <EmptyState title="No holder on this page matches.">The filter looks only at the {fmtCount(loaded.length)} holders on this page.</EmptyState>
          ) : search && (eff.what || eff.min || eff.max || eff.chain !== HOLDER_DEFAULT.chain) ? (
            // a filter beside the search may be what empties the list: the search itself may well find holders
            <EmptyState title={`No holder matches “${search}” with these filters.`}>Remove a filter above to see more holders.</EmptyState>
          ) : search ? (
            <EmptyState title={`No holder matches “${search}”.`}>{HOLDER_SEARCH_EMPTY}</EmptyState>
          ) : (
            <EmptyState title={applied.count ? 'No holder matches these filters.' : 'No holder rows came back.'}>{applied.count ? 'Remove a filter above to see more holders.' : 'The search looks at addresses and names.'}</EmptyState>
          )
        ) : null}

        {data && !empty ? <div className="act-foot">{pager('foot')}</div> : null}

        {scope.length ? <SourceLine items={scope} label="Where the holder figures come from" text={scopeText} /> : <p className="src act-src-ph" aria-hidden="true" />}
      </div>
      </WallClock>
    </>
  );
}

// ---------------------------------------------------------------- one holder row
/** The largest total on the first page of each list (its filters' key) seen this visit: the share bars' reference. */
const LIST_TOP = new Map<string, number>();
/** A share of supply: a holding above zero that rounds to 0.00% reads "<0.01%", never "0.00%". */
const fmtShare = (n: number) => (n > 0 && n < 0.005 ? '<0.01%' : fmtPctRule(n));

function Row({
  h,
  s,
  wall,
  mixed,
  top,
  anyChange,
  both,
  onAddr,
  rowIndex,
}: {
  h: Holder;
  s: { status: SourceStatus; note: string | null };
  wall: number;
  /** the list is not dimmed as a whole: a stale row carries its own mark */
  mixed: boolean;
  top: number;
  anyChange: boolean;
  both: boolean;
  onAddr: (h: Holder) => void;
  rowIndex?: number;
}) {
  const name = holderName(h);
  const shownName = name ?? fmtAddr(h.address);
  const tagWord = holderTag(h);
  // a wallet's own tag: its byline ("Tag by tnam1…"), without the ring of a curated category
  const catTag = tagWord ? <Tag cat={tagWord} ring={!isUserTag(h)} /> : null;

  const conflict = s.status === 'conflict' && h.bonded != null && h.bondedEstimated != null;
  const diff = conflict ? Math.abs((h.bonded as number) - (h.bondedEstimated as number)) : 0;
  const twoReadings: Stamp | null = conflict
    ? {
        source: TECH.namadaStakes,
        at: h.bondedVerifiedAt,
        status: 'conflict',
        note: s.note ?? 'Two readings of this address’s staked NAM differ. The chain reading is shown; the other is the estimate from staking history.',
        extra: [
          ['Staked, read from the chain', `${fmtNamRule(h.bonded)} NAM`],
          ['Staked, estimate from staking history', `${fmtNamRule(h.bondedEstimated)} NAM`],
          ['Difference', `${fmtNamRule(diff)} NAM`],
        ],
      }
    : null;
  const estOnly = h.chain === 'namada' && h.bondedVerifiedAt == null && (h.bondedEstimated ?? 0) > 0;
  const staleMark =
    mixed && s.status === 'stale' ? (
      <ProvDot
        p={{ source: h.chain === 'namada' ? TECH.namadaBalances : TECH.osmosisBalances, plain: h.chain === 'namada' ? undefined : 'Osmosis chain', at: h.verifiedAt, status: 'stale', note: s.note ?? undefined }}
        label="Spendable balance"
        text={h.verifiedAt != null ? `checked ${fmtAge(wall - h.verifiedAt)} ago` : 'not yet checked on chain'}
      />
    ) : null;

  const linked = h.linked?.length ? ` · +${fmtCount(h.linked.length)} linked on ${h.chain === 'namada' ? 'Osmosis' : 'Namada'}` : '';
  const c7 = h.change7d != null && h.change7d !== 0 ? h.change7d : null;

  return (
    <HolderRow
      rank={h.rank}
      rowIndex={rowIndex}
      name={
        <button type="button" className="act-name" title={h.address} onClick={() => onAddr(h)} aria-label={`${shownName}: open address ${h.address}`}>
          {shownName}
        </button>
      }
      sub={
        <>
          {name ? fmtAddr(h.address) : 'no label'}
          {both ? ` · ${h.chain === 'namada' ? 'Namada' : 'Osmosis'}` : ''}
          {linked}
          {c7 != null ? (
            <span className="act-chg">
              {' · '}
              <Num v={c7} fmt={fmtNamSigned} /> in 7 days
            </span>
          ) : null}
        </>
      }
      tags={catTag || staleMark ? <>{catTag}{staleMark}</> : null}
      total={<Num v={h.total} fmt={fmtNamRule} unit="NAM" />}
      share={<Num v={h.pctSupply} fmt={fmtShare} unit="of supply" showReason={false} />}
      spendable={<Num v={h.balance} fmt={fmtNamRule} />}
      staked={h.chain === 'osmosis' ? <span aria-label="No staking on Osmosis">—</span> : <Num v={h.bonded} fmt={fmtNamRule} status={conflict ? 'disagree' : undefined} showReason={false} />}
      stakedNote={
        conflict && twoReadings ? (
          <ProvDot p={twoReadings} label="Staked NAM, two readings" text={`estimate ${fmtNamRule(h.bondedEstimated)}`} />
        ) : estOnly ? (
          <ProvDot p={{ source: TECH.stakeEstimate, at: null, status: 'stale', note: 'Staked NAM is estimated from staking history; it has not been read from the chain yet.' }} label="Staked NAM" text="estimate" />
        ) : null
      }
      change7d={anyChange ? <Num v={h.change7d} fmt={fmtNamSigned} showReason={false} /> : undefined}
      exception={conflict && twoReadings ? <ProvDot p={twoReadings} label="Staked NAM, two readings" text={`staked figures differ by ${fmtNamRule(diff)} NAM`} wrap /> : null}
      bar={top > 0 ? h.total / top : null}
    />
  );
}
