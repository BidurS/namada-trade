// Activity, Holders tab (system.md 9.5, reference final/holders.html): the biggest NAM holders.
//
// Rows: the two-line holder rows of Home with a hairline share bar; Spendable and Staked columns
// from a 930 px container; the 7-day column only when any value is not zero (otherwise said once).
// Provenance: the list is one scope with one SourceLine. When every balance is old the list is
// dimmed once and says so in one sentence; a row that differs carries its own mark (the server's
// status, owner decision 7: `conflict` shows both staked readings).
//
// Data: GET /api/holders (chain, sort, search, pages). It does not take `at`: under Rewind the list
// is current and says so ("Balances were not recorded over time; these are current, not as of …").
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Holder, HoldersResponse, Overview, SourceStatus } from '../../../../shared/types';
import { fetchHolders, holdersCsvHref } from '../../api';
import { REWIND_WORDS, navigate, useNow, useOverlays, useReplay } from '../../app/index';
import { Button, DataList, EmptyState, HolderRow, Notice, Num, PageTools, Pager, ProvDot, Segmented, SelectChip, Skeleton, SourceLine, Tag, WallClock, sourcesText, stepFor, type ScopeItem, type Stamp } from '../../ui';
import { useListKeys, type ListKey } from '../../app/keys';
import { ageRange } from '../../lib/prov';
import { holderCatKey as catKey, holderName, holderTag, isUserTag } from '../../lib/holder';
import { category_plain } from '../../../../shared/labels';
import { fmtAddr, fmtAge, fmtCount, fmtNamRule, fmtNamSigned, fmtPctRule } from '../../lib/format';
import { ActivityBar, FilterPanel, FilterSet, KeysHint, SearchField, useRovingRows } from './parts';
import { TECH } from './words';
import { HOLDER_CSV_MAX, PAGE_SIZES, firstVisibleRow, flashRow, focusFirstRow, focusRow, listHref, pageCount, pageHref, pageOfRank, revealRow } from './paging';

export interface HolderFilters {
  chain: 'namada' | 'osmosis' | 'all';
  by: 'total' | 'liquid' | 'bonded';
  /** a raw category, 'none' (no label) or 'all' */
  cat: string;
  search: string;
}
export const H_DEFAULT: HolderFilters = { chain: 'namada', by: 'total', cat: 'all', search: '' };
export const holderFilterCount = (f: HolderFilters): number => (Object.keys(H_DEFAULT) as (keyof HolderFilters)[]).filter((k) => f[k] !== H_DEFAULT[k]).length;

const H6 = 6 * 3_600_000;
const H24 = 24 * 3_600_000;
const BY_WORD: Record<HolderFilters['by'], string> = { total: 'total NAM', liquid: 'spendable NAM', bonded: 'staked NAM' };
const CHAIN_WORD: Record<HolderFilters['chain'], string> = { namada: 'on Namada', osmosis: 'on Osmosis', all: 'on Namada and Osmosis' };

/** The widest rank on the page, in characters of the rank's mono face ("1,204" is 5). */
const rkChars = (ranks: number[]): number => Math.max(0, ...ranks.map((r) => fmtCount(r).length));
/** One character of the rank's 12 px mono face, in px (0.6 em, plus a little room). */
const RK_CH_PX = 7.6;

const statusOf = (h: Holder): { status: SourceStatus; note: string | null } => ({ status: h.status, note: h.statusNote ?? null });

/**
 * The "What" counts over every holder the chain and search select (the category left out), when the server
 * sends them (HoldersResponse.categories; absent on older servers). `category` is the raw category in lower
 * case, or 'none' for no label; `total` counts every holder the chain and search select.
 */
type CatCounts = { total: number; counts: { category: string; n: number }[] };
const catCountsOf = (r: HoldersResponse): CatCounts | null => (r as HoldersResponse & { categories?: CatCounts | null }).categories ?? null;

export default function Holders({
  filters,
  setFilters,
  wide,
  overview,
  page,
  size,
}: {
  filters: HolderFilters;
  setFilters: (f: HolderFilters) => void;
  wide: boolean;
  overview: Overview | null;
  /** The page from ?page= (1 when absent). */
  page: number;
  /** Rows per page, from ?size= (PAGE_SIZE when absent). */
  size: number;
}) {
  const { at, rewound } = useReplay();
  const wall = useNow(); // balances are current: their ages are measured from the wall clock, also under Rewind
  const { openAddress } = useOverlays();
  const [sheet, setSheet] = useState(false);

  // ---- server query (chain, sort, category, search) and the page from the URL; a page change replaces the rows
  const by = filters.chain === 'osmosis' ? 'total' : filters.by;
  const category = filters.cat === 'all' ? '' : filters.cat;
  const key = JSON.stringify([filters.chain, by, filters.search, category]);
  const [data, setData] = useState<{ key: string; rows: Holder[]; total: number; page: number; size: number; cats: CatCounts | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    fetchHolders(filters.chain, page, size, filters.search, by, category)
      .then((r) => live && setData({ key, rows: r.holders, total: r.total, page, size, cats: catCountsOf(r) }))
      .catch(() => live && setError(page > 1 ? 'This page of holders could not be fetched from this site’s server.' : 'The holder list could not be fetched from this site’s server.'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, page, size, retry]);
  // the same query (any page, any size): the count and the chips stay while another page loads
  const fresh = data?.key === key ? data : null;
  const loaded = fresh?.rows ?? [];
  const pages = fresh ? pageCount(fresh.total, size) : null;
  /** The rows on screen are the ones the URL asks for. */
  const current = !!fresh && fresh.page === page && fresh.size === size;
  // a page past the end (an old link, a list that shrank): the last page, without a history entry
  const past = current && pages != null && page > pages;
  useEffect(() => {
    if (past && pages != null) navigate(pageHref(pages), { replace: true, scroll: false });
  }, [past, pages]);

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
    if (fresh && rank > fresh.total) {
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
    navigate(listHref({ page: to, size: n }), { scroll: false });
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
  // A server that sends HoldersResponse.categories counts every holder the chain and search select, so a chip's
  // count is the number of holders choosing it lists. An older server sends none: then the chips count the
  // biggest holders loaded without a category filter, and the legend says so. The server filters by category
  // (?category=); a server that predates that returns every category, and the loaded rows are filtered here.
  const [catRows, setCatRows] = useState<{ base: string; rows: Holder[]; server: CatCounts | null } | null>(null);
  const baseKey = JSON.stringify([filters.chain, by, filters.search]);
  useEffect(() => {
    if (!fresh) return;
    // the server's counts leave the category out, so any answer for this chain and search carries them
    if (fresh.cats) setCatRows({ base: baseKey, rows: [], server: fresh.cats });
    // an older server: the chips count the biggest holders, page 1 of the list without a category
    else if (filters.cat === 'all' && fresh.page === 1) setCatRows({ base: baseKey, rows: loaded, server: null });
  }, [fresh, filters.cat, baseKey, loaded]);
  const cats = useMemo(() => {
    const mine = catRows?.base === baseKey ? catRows : null;
    const m = new Map<string, { label: string; n: number }>();
    const word = (k: string, plain?: string | null) => (k === 'none' ? 'No label' : plain ?? category_plain(k) ?? k);
    let allN: number;
    let whole = false;
    if (mine?.server) {
      whole = true;
      allN = mine.server.total;
      for (const c of mine.server.counts) if (c.n > 0) m.set(c.category, { label: word(c.category), n: c.n });
    } else {
      const src = mine ? mine.rows : filters.cat === 'all' && fresh?.page === 1 ? loaded : [];
      allN = src.length;
      for (const h of src) {
        const k = catKey(h);
        const e = m.get(k) ?? { label: word(k, h.category_plain), n: 0 };
        e.n += 1;
        m.set(k, e);
      }
    }
    const list = [...m.entries()].sort((a, b) => (a[0] === 'none' ? 1 : b[0] === 'none' ? -1 : b[1].n - a[1].n));
    if (filters.cat !== 'all' && !m.has(filters.cat)) list.push([filters.cat, { label: word(filters.cat), n: 0 }]);
    return { list, allN, whole };
  }, [catRows, baseKey, loaded, filters.cat, fresh?.page]);
  /** The chip legend: plain "What" when the counts cover every holder, else what they count. */
  const catLegend = cats.whole || !cats.allN ? 'What' : `What, counted among the ${fmtCount(cats.allN)} biggest loaded`;
  const serverFiltered = filters.cat === 'all' || loaded.every((h) => catKey(h) === filters.cat);
  const rows = serverFiltered ? loaded : loaded.filter((h) => catKey(h) === filters.cat);

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

  // ---- the list's scope (one SourceLine)
  const scope: ScopeItem[] = [];
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

  // ---- filters
  const count = holderFilterCount(filters);
  const set = (patch: Partial<HolderFilters>) => setFilters({ ...filters, ...patch });
  const shown = rows.length;
  const showN = serverFiltered && fresh ? fresh.total : shown;
  const showLabel = !fresh ? 'Show holders' : `Show ${fmtCount(showN)} holder${showN === 1 ? '' : 's'}`;
  const search = (compact: boolean) => (
    <SearchField label="Search holders by address or name" compact={compact} value={filters.search} onChange={(v) => set({ search: v, cat: 'all' })} placeholder={compact ? 'Search an address or name' : 'tnam1…, osmo1… or a name'} />
  );
  const controls = (
    <>
      <FilterSet label="Chain">
        <Segmented label="Chain" value={filters.chain} onChange={(v) => set({ chain: v, cat: 'all' })} options={[{ value: 'namada', label: 'Namada' }, { value: 'osmosis', label: 'Osmosis' }, { value: 'all', label: 'Both' }]} />
      </FilterSet>
      {filters.chain !== 'osmosis' ? (
        <FilterSet label="Biggest by">
          <Segmented label="Biggest by" value={filters.by} onChange={(v) => set({ by: v })} options={[{ value: 'total', label: 'Total' }, { value: 'liquid', label: 'Spendable' }, { value: 'bonded', label: 'Staked' }]} />
        </FilterSet>
      ) : null}
      <SelectChip
        label={catLegend}
        className="act-cats"
        value={filters.cat}
        onChange={(v) => set({ cat: v })}
        options={[{ value: 'all', label: 'All', count: cats.allN || null }, ...cats.list.map(([k, c]) => ({ value: k, label: c.label, count: c.n }))]}
      />
      {wide ? null : search(false)}
      {count ? (
        <Button variant="secondary" size="sm" className="act-clear" onClick={() => setFilters(H_DEFAULT)}>
          Clear filters
        </Button>
      ) : null}
    </>
  );

  const busy = !!data && (data.key !== key || data.page !== page || data.size !== size || past);
  const top = rows.length ? Math.max(...loaded.map((h) => h.total)) : 0;
  const full = filters.chain !== 'osmosis';
  const empty = !!fresh && !busy && rows.length === 0;

  // ---- column heads on the desktop table: Total, Spendable and Staked sort the list (the "Biggest by" choice)
  const sortHead = (v: HolderFilters['by'], word: string) => (
    <button type="button" className="dl__sort" data-sort={v} aria-label={`${word}, biggest first`} onClick={() => set({ by: v })}>
      <span className="dl__sorti" aria-hidden="true">↓</span>
      <span>{word}</span>
    </button>
  );
  const columns = full
    ? [
        { label: '#' },
        { label: 'Holder' },
        { label: sortHead('total', 'Total NAM'), align: 'r' as const },
        { label: 'Share', align: 'r' as const },
        { label: sortHead('liquid', 'Spendable'), align: 'r' as const },
        { label: sortHead('bonded', 'Staked'), align: 'r' as const },
        ...(anyChange ? [{ label: '7 days', align: 'r' as const }] : []),
      ]
    : undefined;
  // aria-sort sits on the column head itself (the kit's DataList draws the heads; the state is set here)
  useLayoutEffect(() => {
    listRef.current?.querySelectorAll('.dl__head [role="columnheader"]').forEach((h) => {
      const b = h.querySelector('[data-sort]');
      if (!b) h.removeAttribute('aria-sort');
      else h.setAttribute('aria-sort', b.getAttribute('data-sort') === by ? 'descending' : 'none');
      b?.classList.toggle('is-on', b.getAttribute('data-sort') === by);
    });
  });

  const csv =
    fresh && fresh.total > 0 ? (
      <a className="link act-csv" href={holdersCsvHref({ chain: filters.chain, by, category, search: filters.search })} download>
        <span>Download page data</span>
        {/* the export holds the biggest HOLDER_CSV_MAX of these holders (worker/src/api.ts /api/export/holders) */}
        <span className="act-csv__n">{fresh.total > HOLDER_CSV_MAX ? `CSV, biggest ${fmtCount(HOLDER_CSV_MAX)}` : 'CSV, all of them'}</span>
      </a>
    ) : null;

  const pager = (where: 'head' | 'foot') =>
    fresh && pages != null ? (
      <Pager label={where === 'head' ? 'Holder pages' : 'Holder pages, under the list'} page={page} pages={pages} hrefFor={pageHref} onGo={onGo} run={where === 'foot'} className={`act-pager act-pager--${where}`} />
    ) : (
      <div className="pager act-pager act-pager--ph" aria-hidden="true" />
    );

  return (
    <>
      <ActivityBar view="holders" wide={wide} filterCount={count} filterOpen={sheet} onFilter={() => setSheet(true)} search={wide ? search(true) : null} />
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
        ) : null}
        <div className="act-head" ref={headRef}>
          <p className="act-count" aria-live="polite">
            {!fresh ? (
              <span className="skel__b act-count__sk" aria-hidden="true" />
            ) : serverFiltered ? (
              <>
                A total of <Num v={fresh.total} fmt={fmtCount} /> {fresh.total === 1 ? 'holder' : 'holders'} found {CHAIN_WORD[filters.chain]}
                {filters.cat !== 'all' ? <> in “{cats.list.find(([k]) => k === filters.cat)?.[1].label ?? filters.cat}”</> : null}
                {filters.search ? <> matching “{filters.search}”</> : null}, biggest first by {BY_WORD[by]}.
              </>
            ) : (
              <>
                <Num v={shown} fmt={fmtCount} /> of the <Num v={loaded.length} fmt={fmtCount} /> holders on this page match; a total of <Num v={fresh.total} fmt={fmtCount} /> holders found {CHAIN_WORD[filters.chain]}.
              </>
            )}
          </p>
          <div className="act-head__end">
            {wide ? csv : null}
            {pager('head')}
          </div>
        </div>
        {fresh && fresh.total > 0 ? (
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
              label={`Biggest NAM holders ${CHAIN_WORD[filters.chain]}`}
              old={listOld}
              className="act-holders"
            >
              {(busy ? data.rows : rows).map((h) => (
                <Row key={h.chain + h.address} h={h} s={stOf(h)} wall={wall} mixed={!listOld} top={top} anyChange={full && anyChange} both={filters.chain === 'all'} onAddr={openAddress} />
              ))}
            </DataList>
          </div>
        )}

        {empty ? (
          filters.chain === 'osmosis' && !filters.search && filters.cat === 'all' ? (
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
          ) : filters.cat !== 'all' && !serverFiltered ? (
            <EmptyState title="No holder on this page matches.">The filter looks only at the {fmtCount(loaded.length)} holders on this page.</EmptyState>
          ) : (
            <EmptyState title={filters.search ? `No holder matches “${filters.search}”.` : 'No holder rows came back.'}>The search looks at addresses and names.</EmptyState>
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
function Row({
  h,
  s,
  wall,
  mixed,
  top,
  anyChange,
  both,
  onAddr,
}: {
  h: Holder;
  s: { status: SourceStatus; note: string | null };
  wall: number;
  /** the list is not dimmed as a whole: a stale row carries its own mark */
  mixed: boolean;
  top: number;
  anyChange: boolean;
  both: boolean;
  onAddr: (a: string) => void;
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
      name={
        <button type="button" className="act-name" title={h.address} onClick={() => onAddr(h.address)} aria-label={`${shownName}: open address ${h.address}`}>
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
      share={<Num v={h.pctSupply} fmt={(n) => fmtPctRule(n)} unit="of supply" showReason={false} />}
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
