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
import { useEffect, useMemo, useState } from 'react';
import type { Holder, HoldersResponse, Overview, SourceStatus } from '../../../../shared/types';
import { fetchHolders, holdersCsvHref } from '../../api';
import { REWIND_WORDS, useNow, useOverlays, useReplay } from '../../app/index';
import { Button, DataList, EmptyState, HolderRow, Notice, Num, ProvDot, Segmented, SelectChip, Skeleton, SourceLine, Tag, WallClock, sourcesText, type ScopeItem, type Stamp } from '../../ui';
import { ageRange } from '../../lib/prov';
import { holderCatKey as catKey, holderName, holderTag, isUserTag } from '../../lib/holder';
import { category_plain } from '../../../../shared/labels';
import { fmtAddr, fmtAge, fmtCount, fmtNamRule, fmtNamSigned, fmtPctRule } from '../../lib/format';
import { ActivityBar, FilterPanel, FilterSet, SearchField } from './parts';
import { TECH } from './words';

export interface HolderFilters {
  chain: 'namada' | 'osmosis' | 'all';
  by: 'total' | 'liquid' | 'bonded';
  /** a raw category, 'none' (no label) or 'all' */
  cat: string;
  search: string;
}
export const H_DEFAULT: HolderFilters = { chain: 'namada', by: 'total', cat: 'all', search: '' };
export const holderFilterCount = (f: HolderFilters): number => (Object.keys(H_DEFAULT) as (keyof HolderFilters)[]).filter((k) => f[k] !== H_DEFAULT[k]).length;

const PAGE = 50;
const H6 = 6 * 3_600_000;
const H24 = 24 * 3_600_000;
const BY_WORD: Record<HolderFilters['by'], string> = { total: 'total NAM', liquid: 'spendable NAM', bonded: 'staked NAM' };
const CHAIN_WORD: Record<HolderFilters['chain'], string> = { namada: 'on Namada', osmosis: 'on Osmosis', all: 'on Namada and Osmosis' };

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
}: {
  filters: HolderFilters;
  setFilters: (f: HolderFilters) => void;
  wide: boolean;
  overview: Overview | null;
}) {
  const { at, rewound } = useReplay();
  const wall = useNow(); // balances are current: their ages are measured from the wall clock, also under Rewind
  const { openAddress } = useOverlays();
  const [sheet, setSheet] = useState(false);

  // ---- server query (chain, sort, category, search) and pages
  const by = filters.chain === 'osmosis' ? 'total' : filters.by;
  const category = filters.cat === 'all' ? '' : filters.cat;
  const key = JSON.stringify([filters.chain, by, filters.search, category]);
  const [data, setData] = useState<{ key: string; rows: Holder[]; total: number; page: number; cats: CatCounts | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    fetchHolders(filters.chain, 1, PAGE, filters.search, by, category)
      .then((r) => live && setData({ key, rows: r.holders, total: r.total, page: 1, cats: catCountsOf(r) }))
      .catch(() => live && setError('The holder list could not be fetched from this site’s server.'));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  const loadMore = () => {
    if (!data || more) return;
    setMore(true);
    fetchHolders(filters.chain, data.page + 1, PAGE, filters.search, by, category)
      .then((r) =>
        setData((d) => {
          if (!d || d.key !== key) return d;
          const ids = new Set(d.rows.map((x) => x.chain + x.address));
          return { ...d, rows: [...d.rows, ...r.holders.filter((x) => !ids.has(x.chain + x.address))], total: r.total, page: d.page + 1 };
        }),
      )
      .catch(() => setError('More holders could not be fetched from this site’s server.'))
      .finally(() => setMore(false));
  };
  const fresh = data?.key === key ? data : null;
  const loaded = fresh?.rows ?? [];

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
    else if (filters.cat === 'all') setCatRows({ base: baseKey, rows: loaded, server: null });
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
      const src = mine ? mine.rows : filters.cat === 'all' ? loaded : [];
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
  }, [catRows, baseKey, loaded, filters.cat]);
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

  const busy = !!data && data.key !== key;
  const top = rows.length ? Math.max(...loaded.map((h) => h.total)) : 0;
  const full = filters.chain !== 'osmosis';

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
        <p className="act-count" aria-live="polite">
          {!fresh ? (
            <span className="skel__b act-count__sk" aria-hidden="true" />
          ) : serverFiltered ? (
            <>
              <Num v={loaded.length} fmt={fmtCount} /> of <Num v={fresh.total} fmt={fmtCount} /> holders {CHAIN_WORD[filters.chain]}
              {filters.cat !== 'all' ? <> in “{cats.list.find(([k]) => k === filters.cat)?.[1].label ?? filters.cat}”</> : null}
              {filters.search ? <> matching “{filters.search}”</> : null}, biggest first by {BY_WORD[by]}.
            </>
          ) : (
            <>
              <Num v={shown} fmt={fmtCount} /> of the <Num v={loaded.length} fmt={fmtCount} /> biggest holders loaded match; <Num v={fresh.total} fmt={fmtCount} /> holders {CHAIN_WORD[filters.chain]} in all.
            </>
          )}
        </p>

        {error && !fresh ? (
          <Notice tone="warning" title="The holders did not load" action={<Button size="sm" onClick={() => setRetry((n) => n + 1)}>Try again</Button>}>
            {error}
          </Notice>
        ) : !data ? (
          <Skeleton rows={8} heights={[64]} label="holders" className="act-skel" />
        ) : fresh && rows.length === 0 ? null : (
          <div className={busy ? 'is-busy' : undefined}>
            <DataList
              kind="holders"
              full={full}
              change={full && anyChange}
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

        {fresh && rows.length === 0 ? (
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
            <EmptyState title="No holder among those loaded matches.">The filter looks only at the {fmtCount(loaded.length)} biggest holders loaded so far.</EmptyState>
          ) : (
            <EmptyState title={filters.search ? `No holder matches “${filters.search}”.` : 'No holder rows came back.'}>The search looks at addresses and names.</EmptyState>
          )
        ) : null}

        {scope.length ? <SourceLine items={scope} label="Where the holder figures come from" text={scopeText} /> : <p className="src act-src-ph" aria-hidden="true" />}
      </div>
      </WallClock>

      {fresh && loaded.length > 0 ? (
        <div className="act-more">
          {loaded.length < fresh.total ? (
            <Button variant="secondary" busy={more} onClick={loadMore}>
              Load more holders
            </Button>
          ) : null}
          {/* these repeat the count line, whose source is the list's SourceLine above */}
          <p className="cap" data-prov-ref="act-h-scope">
            <Num v={loaded.length} fmt={fmtCount} /> of <Num v={fresh.total} fmt={fmtCount} /> loaded.
            {error && fresh ? ` ${error}` : ''}
          </p>
          <a className="link act-csv" href={holdersCsvHref({ chain: filters.chain, by, category, search: filters.search })} download>
            <span>Export these holders as CSV</span>
          </a>
        </div>
      ) : null}
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
