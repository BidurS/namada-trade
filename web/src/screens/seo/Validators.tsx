// /validators: "Who validates Namada, and how is the staked NAM spread?" (docs/design/platform-plan.md, release C).
// Band: how many validators have stake (hero, ProvChip) and how few of them, largest first, hold more than a third
// and more than two thirds of the staked NAM (fact strip, one SourceLine): a statement of how the stake is spread,
// nothing else. Evidence: every validator of the day as a table (stacked rows on a phone, never a <table>), with a
// text filter, three orders and the first rows shown until "Show all" is asked for; a row's name opens that validator
// in place (?v=<address>, so it can be linked): its stake over its days on record as a small line, the first and the
// last figure with their days, and what the day's listing says of it.
//
// The figures are GET /api/validators (one UTC day, the newest left out) and GET /api/validators/history. The route
// takes a day, not a time: while rewound the page asks for the day of the rewound moment and shows the listing that
// had been made by then (listingAt). A validator's name is the chain's own text: printed as text through
// validatorNameShown (shared/validators.ts), never part of a URL, a class name or markup; the link carries the address.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { ScreenProps } from '../../app/index';
import { Link, navigate, useClock, useReplay, useRoute } from '../../app/index';
import type { ValidatorHistoryResponse, ValidatorRow, ValidatorsResponse } from '../../../../shared/types';
import { BODY } from '../../../../shared/copy';
import { isWholeAddress } from '../../../../shared/search-grammar';
import {
  STATE_NOT_RECORDED, VALIDATORS_SHOWN, VALIDATORS_SOURCE, VALIDATOR_DAYS_MAX, VALIDATOR_NAMES_SOURCE, spreadLabel, validatorNameShown, validatorStateWords,
} from '../../../../shared/validators';
import { HeroNumber, Num, ProvChip, ProvScope, SearchField, Segmented, Skeleton, SourceLine, Sparkline, useShowAll, type ScopeItem, type SegOption, type Stamp } from '../../ui';
import { ApiError, fetchValidatorHistory, fetchValidators } from '../../api';
import { fmtAddr, fmtCount, fmtDayMonth, fmtDayMonthYear, fmtNamRule, fmtNamSigned, fmtSharePct, fmtUtcLong } from '../../lib/format';
import { ageRange } from '../../lib/prov';
import { Band, Dateline, Facts, Fig, FigList, Hero, Related, Say, fromOne, missing, noAnswer, useLoad, type FigRow } from './parts';

const copy = BODY.validators;
const DAY_MS = 86_400_000;
const NODE = 'Namada node';
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A day of the record as a time (the start of that UTC day), for the date formats and the line's axis. */
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
/** Commission as a percent: whole numbers stay whole, otherwise up to two decimals (as the Staking page writes it). */
const pctTrim = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
const pctOf = (fraction: number | null | undefined) => (fraction != null ? fraction * 100 : null);

/**
 * The listing as it stood at a rewound moment: the listing of that UTC day when it had been made by then, else the
 * day on record before it. A day with no listing (before the record began, a day that was missed, or the hours of a
 * day before its listing): the newest day on record before it, as far back as the route lists days. null: none.
 */
async function listingAt(at: number): Promise<ValidatorsResponse | null> {
  const day = isoDay(at);
  try {
    const d = await fetchValidators(day);
    if (d.prov.at == null || d.prov.at <= at) return d;
    return d.prev ? await fetchValidators(d.prev) : null;
  } catch (e) {
    // the route refuses a day it has no listing of (400); anything else is a failure
    if (!(e instanceof ApiError && e.status === 400)) throw e;
    const newest = await fetchValidators();
    const before = newest.days.find((x) => x < day);
    return !before ? null : before === newest.day ? newest : fetchValidators(before);
  }
}

/** A stamp as it read at a rewound moment: current when its day was that moment's or the day before, old otherwise. */
const stampAt = (p: Stamp, day: string, at: number): Stamp => {
  if (p.status === 'missing') return p;
  const current = day >= isoDay(at - DAY_MS);
  return { ...p, status: current ? 'live' : 'stale', note: current ? undefined : 'No listing of a newer day was on record at that time.' };
};

type SortKey = 'stake' | 'commission' | 'addresses';
const SORTS: SegOption<SortKey>[] = [
  { value: 'stake', label: 'Stake' },
  { value: 'commission', label: 'Commission' },
  { value: 'addresses', label: 'Addresses' },
];
const HEADS: { label: string; cls: string; right?: boolean }[] = [
  { label: '#', cls: 'rk' }, { label: 'Validator', cls: 'id' }, { label: 'Stake', cls: 'tot', right: true }, { label: 'Share', cls: 'pct', right: true },
  { label: 'Addresses', cls: 'del', right: true }, { label: 'Commission', cls: 'com', right: true }, { label: 'State', cls: 'st' }, { label: 'Change', cls: 'chg', right: true },
];

interface Ranked { v: ValidatorRow; rank: number; shown: string | null }

export function Validators({ route }: ScreenProps) {
  const { at, rewound } = useReplay();
  const { params, path } = useRoute();
  const now = useClock();
  // the listing changes once a day: asked again every few minutes while live, once for a rewound moment
  const list = useLoad(`validators:${at ?? 'live'}`, () => (at ? listingAt(at) : fetchValidators()).then((d) => ({ d })), { everyMs: at ? undefined : 300_000 });
  const loading = list.loading;
  const d = list.data?.d ?? null;

  // ?v=<address>: the validator opened in place. Anything that is not a whole Namada address opens nothing.
  const v = params.get('v');
  const sel = v && v.startsWith('tnam1') && isWholeAddress(v) ? v : null;
  const hrefWith = (address: string | null) => {
    const q = new URLSearchParams(params);
    if (address) q.set('v', address);
    else q.delete('v');
    const s = q.toString();
    return s ? `${path}?${s}` : path;
  };
  // a validator opened by a click is brought into view and given focus; one opened by the link the page was loaded with is not
  const oneRef = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    if (!sel || !oneRef.current) return;
    oneRef.current.scrollIntoView({ block: 'start' });
    oneRef.current.focus({ preventScroll: true });
  }, [sel]);

  // the stamps: the listing's own, the indexer list's, and the two made from the listing
  const none = rewound ? 'No validator listing is on record for that day.' : 'No validator listing is on record yet.';
  const off: Stamp | null = loading ? null : !list.data ? noAnswer(VALIDATORS_SOURCE, NODE) : !d ? missing(VALIDATORS_SOURCE, none, NODE) : null;
  const dated = (p: Stamp): Stamp => (at && d?.day ? stampAt(p, d.day, at) : p);
  const listP: Stamp | null = off ?? (d ? dated({ ...d.prov, plain: NODE }) : null);
  const namesP: Stamp | null = off ? { ...off, source: VALIDATOR_NAMES_SOURCE, plain: undefined } : d ? dated(d.namesProv) : null;
  const spreadP: Stamp | null = listP && listP.status !== 'missing' ? fromOne(listP, 'the validators counted from the largest stake down, until their stake together is more than the part named') : listP;
  const changeP: Stamp | null = !listP || listP.status === 'missing'
    ? listP
    : d?.prev
      ? fromOne(listP, `each stake less the same validator's stake in the listing of ${fmtDayMonthYear(dayMs(d.prev))}`)
      : missing(VALIDATORS_SOURCE, 'No earlier day is on record to compare with.', NODE);

  return (
    <article className="seo seo--validators">
      <Hero
        eyebrow={<Dateline label="Validators" />}
        h1={route?.h1 ?? ''}
        sub={copy.paras[0]}
        fig={
          <HeroNumber
            size="48"
            label="Validators with stake"
            chip={loading ? <span className="skel__b skel__chip" aria-hidden="true" /> : <ProvChip p={listP} label="Validators with stake" />}
            value={<Fig loading={loading} h={48} w="4ch" v={d?.count} prov={listP} fmt={fmtCount} />}
            sub="have NAM staked with them."
          />
        }
      >
        <p className="seo-hero__more">{copy.paras[1]}</p>
        <Facts
          className="seo-facts"
          sourceLabel="How the staked NAM is spread"
          items={[
            { n: <Fig loading={loading} v={d?.third} prov={spreadP} fmt={fmtCount} showAge={false} />, label: spreadLabel(d?.third, 'a third'), scope: spreadP ? { label: 'Validators that hold more than a third', p: spreadP } : undefined },
            { n: <Fig loading={loading} v={d?.twoThirds} prov={spreadP} fmt={fmtCount} showAge={false} />, label: spreadLabel(d?.twoThirds, 'two thirds'), scope: spreadP ? { label: 'Validators that hold more than two thirds', p: spreadP } : undefined },
          ]}
        />
      </Hero>

      <Band label="Every validator">
        <section className="seo-sec seo-sec--wide" aria-labelledby="val-list">
          <h2 id="val-list" className="h2 seo-sec__h">Every validator and its stake</h2>
          <div className="seo-sec__b">
            {rewound && at && d?.day ? <Say>{`This is the listing of ${fmtDayMonthYear(dayMs(d.day))}, the newest that had been made at ${fmtUtcLong(at)}.`}</Say> : null}
            {!loading && !list.data ? <Say>The validator listing did not load.</Say> : null}
            {!loading && list.data && !d ? <Say>{none}</Say> : null}
            {d && !d.validators.length ? <Say>{d.prov.note ?? none}</Say> : null}
            {sel ? <One key={sel} address={sel} d={d} waiting={loading} listP={listP} namesP={namesP} rewound={rewound} closeHref={hrefWith(null)} sectionRef={oneRef} /> : null}
            {loading ? <Skeleton rows={8} heights={[86]} label="validators" /> : null}
            {d && d.validators.length && listP && namesP && changeP ? <ValidatorList d={d} listP={listP} namesP={namesP} changeP={changeP} sel={sel} hrefOf={hrefWith} now={now} /> : null}
          </div>
        </section>

        <Related paths={['/staking', '/holders', '/developers']} />
      </Band>
    </article>
  );
}

// ---------------------------------------------------------------- the list

/**
 * The day's validators as a list: the tools (a text filter over name and address, three orders), the rows, the
 * "Show all" button and one SourceLine for every figure in it. Exported for the markup test (test/validators-ui.test.ts).
 */
export function ValidatorList({ d, listP, namesP, changeP, sel, hrefOf, now }: { d: ValidatorsResponse; listP: Stamp; namesP: Stamp; changeP: Stamp; sel: string | null; hrefOf: (address: string) => string; now: number }) {
  const [text, setText] = useState('');
  const [sort, setSort] = useState<SortKey>('stake');
  // the rank is the place by stake in the day's listing, whatever the list is filtered or ordered by
  const all = useMemo<Ranked[]>(() => d.validators.map((v, i) => ({ v, rank: i + 1, shown: validatorNameShown(v.name) })), [d.validators]);
  const rows = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const hit = needle ? all.filter((r) => (r.shown ?? '').toLowerCase().includes(needle) || r.v.validator.includes(needle)) : all;
    if (sort === 'stake') return hit;
    const key = (r: Ranked) => (sort === 'commission' ? r.v.commission : r.v.delegators);
    // largest first; a validator without the figure goes last; equal figures keep the order by stake
    return [...hit].sort((a, b) => {
      const x = key(a), y = key(b);
      if (x == null || y == null) return x == null && y == null ? a.rank - b.rank : x == null ? 1 : -1;
      return y - x || a.rank - b.rank;
    });
  }, [all, text, sort]);
  const [shown, more] = useShowAll(rows, VALIDATORS_SHOWN);
  // the bar is each stake against the day's largest, so the list reads as a shape; the percent beside it is the share
  const top = d.validators[0]?.stake ?? 0;
  const old = listP.status === 'stale' && listP.at != null;
  // The source line sums up the readings behind the figures shown. What was not read at all (the indexer's list for
  // the day, a day before to compare with) is said in a sentence above the rows and left out of that line, so one
  // part that is missing does not make the line say the whole list has no data.
  const scope: ScopeItem[] = [
    { label: 'Stake, share and addresses staked', p: listP },
    ...(namesP.status !== 'missing' ? [{ label: 'Names, commission and state', p: namesP }] : []),
    ...(changeP.status !== 'missing' && d.prev ? [{ label: `Change since ${fmtDayMonthYear(dayMs(d.prev))}`, p: changeP }] : []),
  ];

  return (
    <ProvScope className="val-scope" old={old} oldSentence={old ? `This listing is ${ageRange([listP], now)} old, so it is shown dimmed.` : undefined}>
      {d.day ? <p className="cap">{`The first complete listing of ${fmtDayMonthYear(dayMs(d.day))}, UTC.`}</p> : null}
      {namesP.status === 'missing' && namesP.note ? <Say>{namesP.note}</Say> : null}
      {changeP.status === 'missing' && changeP.note ? <Say>{changeP.note}</Say> : null}
      <div className="val-tools">
        <SearchField label="Find a validator" placeholder="Name or address" value={text} onChange={setText} />
        <div className="val-tools__sort">
          <span className="fset__l" aria-hidden="true">Largest first by</span>
          <Segmented label="Largest first by" value={sort} options={SORTS} onChange={setSort} />
        </div>
      </div>
      {text && !rows.length ? <Say>No validator of this day matches that text.</Say> : null}
      {text && rows.length ? <p className="cap">{`${fmtCount(rows.length)} of ${fmtCount(all.length)} validators match.`}</p> : null}
      {rows.length ? (
        <div className="val-list" role="table" aria-label="Validators and their stake" aria-rowcount={rows.length + 1}>
          <div className="val-head" role="row" aria-rowindex={1}>
            {HEADS.map((h) => (
              <span key={h.cls} role="columnheader" className={`val-head__${h.cls}${h.right ? ' r' : ''}`}>{h.label}</span>
            ))}
          </div>
          {shown.map(({ v, rank, shown: name }, i) => (
            <div key={v.validator} className={`val${v.validator === sel ? ' is-sel' : ''}`} role="row" aria-rowindex={i + 2}>
              <span className="val__rk" role="cell">{fmtCount(rank)}</span>
              <span className="val__id" role="cell">
                <Link to={hrefOf(v.validator)} className="val__name" aria-current={v.validator === sel ? 'true' : undefined}>
                  {name ?? fmtAddr(v.validator)}
                </Link>
                {name ? <span className="val__addr">{fmtAddr(v.validator)}</span> : null}
              </span>
              <span className="val__tot" role="cell"><Num v={v.stake} fmt={fmtNamRule} unit="NAM" /></span>
              <span className="val__pct" role="cell">
                <Num v={pctOf(v.share)} fmt={fmtSharePct} showReason={false} />
                {top > 0 ? <i className="val__bar" style={{ ['--w' as string]: `${(Math.max(0, Math.min(1, v.stake / top)) * 100).toFixed(2)}%` } as CSSProperties} aria-hidden="true" /> : null}
              </span>
              <span className="val__del" role="cell"><span className="val__k">Addresses</span> <Num v={v.delegators} fmt={fmtCount} /></span>
              <span className="val__com" role="cell"><span className="val__k">Commission</span> <Num v={pctOf(v.commission)} fmt={pctTrim} showReason={false} /></span>
              <span className="val__st" role="cell">{validatorStateWords(v.state)}</span>
              {/* the unit is in the cell's own words below 930 px, where a long figure with its unit would not fit (seo.css) */}
              <span className="val__chg" role="cell"><span className="val__k">Change, NAM</span> <Num v={v.changeNam} fmt={fmtNamSigned} unit="NAM" showReason={false} /></span>
            </div>
          ))}
        </div>
      ) : null}
      {more}
      <SourceLine items={scope} label="Where the validator figures come from" />
    </ProvScope>
  );
}

// ---------------------------------------------------------------- one validator, opened in place

/**
 * One validator: what the day's listing says of it (when it has stake that day) and its stake over its days on
 * record. While rewound only the days up to the day shown are drawn, and a validator with no row on that day is
 * said to be not on record for it: a later day's figure is never shown under a rewound moment.
 */
function One({ address, d, waiting, listP, namesP, rewound, closeHref, sectionRef }: { address: string; d: ValidatorsResponse | null; waiting: boolean; listP: Stamp | null; namesP: Stamp | null; rewound: boolean; closeHref: string; sectionRef: RefObject<HTMLElement> }) {
  // a validator with no row at all is an answer (404), not a failure: "Not on record"
  const hist = useLoad<{ h: ValidatorHistoryResponse | null }>(`validator:${address}`, () =>
    fetchValidatorHistory(address, VALIDATOR_DAYS_MAX).then((h) => ({ h }), (e) => {
      if (e instanceof ApiError && e.status === 404) return { h: null };
      throw e;
    }));
  const h = hist.data?.h ?? null;
  const row = d?.validators.find((x) => x.validator === address) ?? null;
  const name = validatorNameShown(row?.name ?? h?.name);
  const loading = hist.loading || waiting;

  const upTo = h ? (rewound && d?.day ? h.days.filter((x) => x.day <= (d.day as string)) : h.days) : [];
  // while rewound the history is shown only when it ends on the day shown, whose listing stamps it
  const days = rewound && upTo[upTo.length - 1]?.day !== d?.day ? [] : upTo;
  const first = days[0], last = days[days.length - 1];
  const histP: Stamp | null = !h ? null : rewound ? listP : { ...h.prov, plain: NODE };
  const lineP: Stamp | null = histP ? fromOne(histP, 'the first complete listing of each day on record for this validator') : null;
  const points = days.map((x) => ({ t: dayMs(x.day), v: x.stake }));

  const rows: FigRow[] = [];
  if (first && last && lineP) {
    if (first.day !== last.day) rows.push({ label: `Staked with it on ${fmtDayMonth(dayMs(first.day))}`, note: 'its first day on record here', value: <Fig h={26} v={first.stake} prov={lineP} fmt={fmtNamRule} unit="NAM" />, p: lineP });
    rows.push({ label: `Staked with it on ${fmtDayMonth(dayMs(last.day))}`, note: 'its newest day on record here', value: <Fig h={26} v={last.stake} prov={lineP} fmt={fmtNamRule} unit="NAM" />, p: lineP });
    rows.push({ label: 'Addresses staked with it', note: `on ${fmtDayMonth(dayMs(last.day))}`, value: <Fig h={26} v={last.delegators} prov={lineP} fmt={fmtCount} />, p: lineP });
  } else if (row && listP) {
    // its days did not load, or do not reach back to the day shown: what the day's listing itself says of it
    rows.push({ label: 'Staked with it', value: <Fig h={26} v={row.stake} prov={listP} fmt={fmtNamRule} unit="NAM" />, p: listP });
    rows.push({ label: 'Addresses staked with it', value: <Fig h={26} v={row.delegators} prov={listP} fmt={fmtCount} />, p: listP });
  }
  // What the indexer's list says of it on the day shown, beside the figures above (never alone: those rows carry the
  // list's source line). A figure that list did not have says so beside its dash, and is left out of that line.
  if (rows.length && row && namesP) {
    rows.push({ label: 'Commission', note: 'the part of the rewards it keeps', value: <Fig h={26} v={pctOf(row.commission)} prov={row.commission != null ? namesP : missingOf(namesP)} fmt={pctTrim} />, p: row.commission != null ? namesP : undefined });
    rows.push({ label: 'State', value: <span className="val-one__state">{validatorStateWords(row.state)}</span>, p: row.state != null ? namesP : undefined });
  }

  return (
    <section className="val-one" ref={sectionRef} tabIndex={-1} aria-labelledby="val-one-h">
      <div className="val-one__top">
        <div className="val-one__t">
          {/* data-name: the heading is a name the chain gave, not a sentence of this site's */}
          <h3 id="val-one-h" className="val-one__h" data-name="">{name ?? fmtAddr(address)}</h3>
          <span className="val-one__a">{address}</span>
        </div>
        <button type="button" className="btn btn--secondary btn--sm" onClick={() => navigate(closeHref)}>Close</button>
      </div>
      {loading ? <Skeleton rows={3} heights={[64]} label="this validator" /> : null}
      {!loading && !hist.data ? <Say>This validator’s days did not load.</Say> : null}
      {!loading && hist.data && !h && !row ? <Say>Not on record: no day on record has a row for this address.</Say> : null}
      {!loading && h && !days.length && !row ? <Say>Not on record for the day shown.</Say> : null}
      {!loading && days.length && !row && d ? <Say>{STATE_LINE}</Say> : null}
      {!loading && rows.length ? (
        <FigList label="This validator" rows={rows}>
          {first && last && points.length > 1 ? (
            <Sparkline
              className="seo-spark"
              points={points}
              label={`NAM staked with it, ${fmtNamRule(first.stake)} NAM on ${fmtDayMonth(dayMs(first.day))} to ${fmtNamRule(last.stake)} NAM on ${fmtDayMonth(dayMs(last.day))}`}
            >
              <span>NAM staked with it, {fmtDayMonth(dayMs(first.day))} to {fmtDayMonth(dayMs(last.day))}</span>
            </Sparkline>
          ) : null}
        </FigList>
      ) : null}
    </section>
  );
}

/** Said when a validator has days on record but no stake in the listing shown. */
const STATE_LINE = 'It has no stake in the listing shown, so its commission and state are not listed.';
/** The names stamp for a figure the indexer's list did not have for this validator. */
const missingOf = (p: Stamp): Stamp => (p.status === 'missing' ? p : { ...p, status: 'missing', note: `${STATE_NOT_RECORDED}: the indexer’s list did not have it.` });
