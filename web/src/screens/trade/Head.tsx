// The token header (S2, screener-plan 2.1, 2.2, 2.3 and 2.7): the top of the black chart block. The NAM price with
// its stamp; its changes over 1 h, 6 h, 24 h, 7 days and 30 days, each a button that opens the two readings it is
// measured between; the pool price's changes on their own row, labelled "pool price, not trades" and never mixed
// with the quoted ones; then four figures: what traded in 24 h at the prices it traded at (with the Osmosis
// pair summary's own figure beside it), the pools' depth, all NAM at today's price and spendable NAM at today's
// price, each label a button that opens its definition. One SourceLine for every figure here.
//
// A window not covered yet is said in one sentence with the server's reason, never 0 or a guess; a route this
// server does not serve reads "—" with NOT_SERVED. "Market cap" is never written: each value says what it counts.
import { useId, useState, type ReactNode } from 'react';
import type { Overview, PriceChange, PriceChangesResponse, VolumeResponse } from '../../../../shared/types';
import { NOT_SERVED } from '../../../../shared/types';
import { Button, Num, SkeletonBlock, SourceLine, derive, fmtPriceNode, type Stamp } from '../../ui/index';
import type { ScopeItem } from '../../ui/index';
import { GlossPop, useGlossPop } from '../../ui/Term';
import { VALUE_WORDS } from '../../../../shared/copy';
import { NBSP, fmtAge, fmtCount, fmtDayClock, fmtDayMonthYear, fmtNamRule, fmtPctSigned, fmtUsdRule, fmtUsdWhole } from '../../lib/format';
import type { HistoryLoad } from './data';
import type { Depth } from './model';
import { POOL_WINDOWS, QUOTED_WINDOWS, WINDOW_WORD, allNamValue, changeCells, lateBase, listWords, spendableValue, type ChangeCell } from './series';

/**
 * What each value counts (copy, no figures). The two value sentences are shared/copy.ts VALUE_WORDS, which the
 * series API sends too (worker/src/series-api.ts FDV_DEFINITION, SPENDABLE_DEFINITION).
 */
export const DEFINE = {
  allNam: VALUE_WORDS.allNam,
  spendable: VALUE_WORDS.spendable,
  depth: 'The money in every Osmosis pool that holds NAM, both sides counted, as the Osmosis router reports it.',
} as const;

/** A label that opens its definition (the glossary term's look: a solid underline, a 44 px hit). */
function Defined({ children, title, text }: { children: ReactNode; title: string; text: string }) {
  const { btnRef, popRef, popId } = useGlossPop();
  return (
    <>
      <button ref={btnRef} type="button" className="term tk-def" aria-haspopup="dialog" aria-expanded="false">{children}</button>
      <GlossPop popRef={popRef} popId={popId} c={{ plain: title, text }} />
    </>
  );
}

export interface HeadProps {
  overview: Overview | null;
  /** the site overview did not answer: its figures read "—" with the reason instead of waiting */
  overviewFailed?: boolean;
  depth: Depth | null;
  changes: HistoryLoad<PriceChangesResponse>;
  volume: HistoryLoad<VolumeResponse>;
  rewound: boolean;
}

const stampOf = (p: { source: string; at: number | null; status: Stamp['status']; note?: string }, plain?: string): Stamp => ({ ...p, ...(plain ? { plain } : {}) });

/** The stamp of a change row: a window that has a figure, else any (so a row of covered windows does not read "no data"). */
const rowProv = (m: Record<string, PriceChange> | null | undefined): PriceChange['prov'] | null => {
  const list = Object.values(m ?? {});
  return (list.find((c) => c.pct != null) ?? list[0])?.prov ?? null;
};

/** What the overview's figures read when it did not answer. */
const NO_OVERVIEW: Stamp = { source: 'site overview', plain: 'Site overview', at: null, status: 'missing', note: 'The site overview did not answer, so this figure is not shown.' };

export function Head({ overview, overviewFailed, depth, changes, volume, rewound }: HeadProps) {
  const price = overview ? overview.price.usd.value : null;
  // the price's own source says it in plain words (prov.ts plainSource): the price list, or the route and its size
  const priceStamp: Stamp | null = overview ? stampOf(overview.price.usd.prov) : null;
  const waiting = !overview && !overviewFailed;

  // ---- all NAM and spendable NAM at today's price (derived: the oldest input's age, the worst status)
  const supplyStamp: Stamp | null = overview ? stampOf(overview.supply.prov, 'Namada node') : null;
  const osmoStamp: Stamp | null = overview ? stampOf(overview.supply.osmosisProv, 'Osmosis supply') : null;
  const allStamp = supplyStamp && priceStamp ? derive([supplyStamp, priceStamp], 'all NAM in existence x the quoted price') : null;
  const spendStamp = supplyStamp && osmoStamp && priceStamp ? derive([supplyStamp, osmoStamp, priceStamp], '(NAM in ordinary accounts on Namada + NAM on Osmosis) x the quoted price') : null;
  const allV = overview ? allNamValue(overview.supply.total, price) : null;
  const spendV = overview ? spendableValue(overview.supply.transparentLiquid, overview.supply.osmosis, price) : null;

  // ---- volume: ours at execution, and the Osmosis pair summary's beside it
  const v = volume.data;
  const v24 = v?.windows.h24 ?? null;
  const volStamp: Stamp | null = v ? stampOf(v.prov, 'Flow index') : null;
  const osmoVolStamp: Stamp | null = v ? stampOf(v.osmosis.prov, 'Osmosis app data') : null;
  const volMissing: Stamp | null = volume.unserved
    ? { source: 'executed NAM swaps (hourly rows)', plain: 'Executed swaps', at: null, status: 'missing', note: NOT_SERVED }
    : volume.error && !v
      ? { source: 'executed NAM swaps (hourly rows)', plain: 'Executed swaps', at: null, status: 'missing', note: volume.error }
      : v && !v24
        ? { ...volStamp!, status: 'missing', note: v.start != null ? `The trades are recorded hour by hour since ${fmtDayMonthYear(v.start)}, which does not cover the last 24 hours yet.` : 'No trade hour is recorded yet.' }
        : null;
  const usd24 = v24 ? v24.usd ?? (v24.usdPriced > 0 ? v24.usdPriced : null) : null;

  // Under Rewind the price is the one quoted then (the overview is read as of that time), so the values say so.
  const atPrice = rewound ? 'at the price then' : 'at today’s price';
  const allLabel = `All NAM ${atPrice}`;
  const spendLabel = `Spendable NAM ${atPrice}`;
  const thenWords = (t: string) => (rewound ? t.replace(/today’s quoted price|today’s price/g, 'the price quoted then') : t);
  const scope: ScopeItem[] = [
    ...(priceStamp ? [{ label: 'NAM price (quoted)', p: priceStamp }] : []),
    ...(changes.data && rowProv(changes.data.quoted) ? [{ label: 'Changes in the quoted price', p: stampOf(rowProv(changes.data.quoted)!, 'Osmosis quote') }] : []),
    ...(changes.data && rowProv(changes.data.pool) ? [{ label: 'Changes in the pool price', p: stampOf(rowProv(changes.data.pool)!, 'Osmosis app data') }] : []),
    ...(overviewFailed && !overview ? [{ label: 'NAM price and supply', p: NO_OVERVIEW }] : []),
    ...(volStamp ? [{ label: 'Traded in 24 hours (at the prices paid)', p: volMissing ?? volStamp }] : volMissing ? [{ label: 'Traded in 24 hours (at the prices paid)', p: volMissing }] : []),
    ...(osmoVolStamp ? [{ label: 'Traded in 24 hours (Osmosis pair summary)', p: osmoVolStamp }] : []),
    ...(depth ? [{ label: 'Pool depth', p: depth.stamp }] : []),
    ...(allStamp ? [{ label: allLabel, p: allStamp }] : []),
    ...(spendStamp ? [{ label: spendLabel, p: spendStamp }] : []),
  ];

  return (
    <section className="tk-head" aria-labelledby="h-head" data-prov-scope="">
      <h2 id="h-head" className="h2">Price, volume and depth</h2>
      <div className="tk-price">
        <span className="tk-price__k">NAM price, as the pools quote it{rewound ? ' then' : ''}</span>
        <span className="tk-price__v">
          {overview ? <Num v={price} prov={priceStamp} fmt={fmtPriceNode} stamp="dot" label="NAM price" as="b" showAge={false} /> : waiting ? <SkeletonBlock height={32} width={160} /> : <Num v={null} prov={NO_OVERVIEW} />}
        </span>
      </div>

      <Changes load={changes} />

      <ul className="facts facts--4 tk-facts">
        <li className="fact">
          <span className="fact__n">
            {volume.loading ? (
              <SkeletonBlock height={28} width={90} />
            ) : volMissing ? (
              <Num v={null} prov={volMissing} />
            ) : (
              <Num v={usd24} fmt={fmtUsdWhole} status={v?.disagree ? 'disagree' : undefined} showReason={false} />
            )}
          </span>
          <span className="fact__l">
            {v ? <Defined title="Traded in 24 hours" text={`${v.definition} ${v.osmosisDefinition}`}>Traded, 24 h</Defined> : 'Traded, 24 h'}
          </span>
          {v24 ? (
            <span className="fact__s">
              <span data-num="">{fmtNamRule(v24.nam)}</span>{NBSP}NAM in <span data-num="">{fmtCount(v24.buys)}</span> {v24.buys === 1 ? 'buy' : 'buys'} and <span data-num="">{fmtCount(v24.sells)}</span> {v24.sells === 1 ? 'sell' : 'sells'}
              {v24.usd == null && v24.unpriced > 0 ? <>; <span data-num="">{fmtCount(v24.unpriced)}</span> without a price are left out of the dollars</> : null}
            </span>
          ) : null}
          {v ? (
            <span className="fact__s">
              Osmosis counts{' '}
              <Num
                v={v.osmosis.value?.usd24h ?? null}
                prov={v.osmosis.value?.usd24h == null ? { ...osmoVolStamp!, status: 'missing', note: osmoVolStamp?.note ?? 'The Osmosis pair summary sent no 24-hour figure.' } : undefined}
                fmt={fmtUsdWhole}
                status={v.disagree ? 'disagree' : undefined}
              />
              {v.disagree ? <> (the two differ by more than a quarter)</> : null}
            </span>
          ) : null}
        </li>
        <li className="fact">
          <span className="fact__n">{depth ? <Num v={depth.usd} prov={depth.usd == null ? depth.stamp : undefined} fmt={fmtUsdWhole} /> : waiting ? <SkeletonBlock height={28} width={90} /> : <Num v={null} prov={NO_OVERVIEW} showReason={false} />}</span>
          <span className="fact__l"><Defined title="Pool depth" text={DEFINE.depth}>Pool depth</Defined></span>
          {depth && depth.count != null ? <span className="fact__s">in <span data-num="">{fmtCount(depth.count)}</span> pools</span> : null}
        </li>
        <li className="fact">
          <span className="fact__n">{overview ? <Num v={allV} prov={allV == null ? allStamp : undefined} fmt={fmtUsdWhole} /> : waiting ? <SkeletonBlock height={28} width={90} /> : <Num v={null} prov={NO_OVERVIEW} showReason={false} />}</span>
          <span className="fact__l"><Defined title={allLabel} text={thenWords(DEFINE.allNam)}>{allLabel}</Defined></span>
        </li>
        <li className="fact">
          <span className="fact__n">{overview ? <Num v={spendV} prov={spendV == null ? spendStamp : undefined} fmt={fmtUsdWhole} /> : waiting ? <SkeletonBlock height={28} width={90} /> : <Num v={null} prov={NO_OVERVIEW} showReason={false} />}</span>
          <span className="fact__l"><Defined title={spendLabel} text={thenWords(DEFINE.spendable)}>{spendLabel}</Defined></span>
        </li>
      </ul>
      {volume.error && !volume.unserved && !v ? (
        <p className="cap tk-retry">
          <Button size="sm" onClick={volume.retry}>Ask for the volume again</Button>
        </p>
      ) : null}
      {scope.length ? <SourceLine items={scope} label="Where the price, volume and depth come from" /> : <p className="src src--wait" aria-hidden="true" />}
    </section>
  );
}

/** The two change rows: the quoted price's, then the pool price's, each cell opening its two readings. */
function Changes({ load }: { load: HistoryLoad<PriceChangesResponse> }) {
  const [open, setOpen] = useState<string | null>(null);
  const id = useId();
  if (load.loading) return <div className="tk-chg" aria-busy="true"><SkeletonBlock height={44} /></div>;
  if (!load.data) {
    const why = load.unserved ? NOT_SERVED : load.error ?? NOT_SERVED;
    return (
      <div className="tk-chg">
        <p className="tk-chg__none">
          Changes over {listWords(QUOTED_WINDOWS.map((w) => WINDOW_WORD[w]))}: <Num v={null} prov={{ source: 'quoted price changes', plain: 'Osmosis quote', at: null, status: 'missing', note: why }} />
        </p>
        {load.error && !load.unserved ? <Button size="sm" onClick={load.retry}>Ask again</Button> : null}
      </div>
    );
  }
  const q = changeCells(load.data.quoted, QUOTED_WINDOWS);
  const p = changeCells(load.data.pool, POOL_WINDOWS);
  const cell = (c: ChangeCell, row: 'q' | 'p') => {
    const k = `${row}${c.window}`;
    const on = open === k;
    return (
      <button key={k} type="button" className={`tk-chg__c${on ? ' is-on' : ''}`} aria-expanded={on} aria-controls={`${id}${row}`} onClick={() => setOpen(on ? null : k)}>
        <span className="tk-chg__w">{c.word}</span>
        <Num v={c.change.pct} fmt={(n) => fmtPctSigned(n)} showReason={false} />
      </button>
    );
  };
  const openCell = [...q.shown.map((c) => ['q', c] as const), ...p.shown.map((c) => ['p', c] as const)].find(([row, c]) => open === `${row}${c.window}`) ?? null;
  return (
    <div className="tk-chg">
      {q.shown.length ? (
        <div className="tk-chg__row" role="group" aria-label="Changes in the quoted price">
          {q.shown.map((c) => cell(c, 'q'))}
        </div>
      ) : null}
      {openCell && openCell[0] === 'q' ? <Base id={`${id}q`} c={openCell[1].change} word={openCell[1].word} what="the quoted price" /> : null}
      {q.notYet.words.length ? (
        <p className="tk-chg__not">
          Not known yet: {listWords(q.notYet.words)}. {q.notYet.notes.join(' ')}
        </p>
      ) : null}
      {p.shown.length ? (
        <>
          <p className="tk-chg__k">Pool price, not trades (Osmosis app data):</p>
          <div className="tk-chg__row" role="group" aria-label="Changes in the pool price">
            {p.shown.map((c) => cell(c, 'p'))}
          </div>
          {openCell && openCell[0] === 'p' ? <Base id={`${id}p`} c={openCell[1].change} word={openCell[1].word} what="the pool price" closes /> : null}
        </>
      ) : null}
      {p.notYet.words.length && p.shown.length ? (
        <p className="tk-chg__not">Pool price, not known yet: {listWords(p.notYet.words)}. {p.notYet.notes.join(' ')}</p>
      ) : !p.shown.length ? (
        <p className="tk-chg__not">Pool price changes (Osmosis app data, not trades): not known. {p.notYet.notes.join(' ')}</p>
      ) : null}
    </div>
  );
}

/** The two readings a change is measured between, and how late its first reading came. */
function Base({ id, c, word, what, closes = false }: { id: string; c: PriceChange; word: string; what: string; closes?: boolean }) {
  const late = lateBase(c);
  // a pool-price reading is an hour's close: its time is the hour's end
  const at = closes ? 'at the close of the hour ending' : 'at';
  return (
    <p className="tk-chg__base" id={id} aria-live="polite">
      {word}: {what} went from <Num v={c.base?.value ?? null} fmt={fmtUsdRule} showReason={false} /> {at} {fmtDayClock(c.base?.at)} to{' '}
      <Num v={c.now?.value ?? null} fmt={fmtUsdRule} showReason={false} /> {at} {fmtDayClock(c.now?.at)}.
      {late != null ? <> The first reading in the window came {fmtAge(late)} after it began.</> : null}
    </p>
  );
}

export default Head;
