// View 3, OVER TIME (depth plan 3.2; step S6): the HeatChart over the stored heat rows (time across, price up, the colour
// the USD resting per band of the reference price), the reference price as the hairline broken at every missing
// minute, the stored trades of the last week as dots sized by their coins (bots left out by the flow index), the three
// windows (a day, a week, a month; the day is the phone default and is drawn there in five-minute columns, the last
// stored minute of each five, minute columns from 1024 px), the honest start from the first recording (the history
// answer's recordedSince: the earlier of the first minute row and the first hourly row, so the minute rows' retention
// edge is never named as the start), the executable line under it (ExecLine) with the window's gaps said in words under
// it, the change rows of the window worded from the diff rows and their owners (a read cut at its page cap says the
// count is a floor), one
// SourceLine for every stored read behind the band, the "What a minute costs" line from the minute's own `cost` and
// "Left out, and why" from its unpriced list and the pools not read. Nothing here types a figure.
import { useMemo, useState } from 'react';
import type { DepthChangeRow, DepthResponse } from '../../../../shared/depth';
import {
  CHANGES_LEAD, CHANGES_NONE, CHANGES_H3, CHANGE_NO_SIZE, CHANGE_VERBS, CHART_VIEW, COST_CAPS, COST_LABEL, CURVE_TRADES_DAYS, DEPTH_QUOTABLE_SIZE, FLOW_INDEX_PLAIN, GAPS_NONE, HEAT_HOW, HEAT_NONE, HEAT_RANGES, HEAT_STEP_WORDS, HEAT_WAITS, HEAT_EDGES, LABEL_WINDOW, LEFT_OUT_LABEL, LEFT_OUT_NONE, OVER_H2, PHONE_FIVE, RESERVES_WHAT, SOURCE_CHANGES, SOURCE_EXEC, SOURCE_HEAT, SOURCE_HOURS, SOURCE_OVER, SOURCE_STORED_TRADES, TABLE_VIEW, BY_WORD,
  changeHead, changesAtLeast, changesInWindow, changesListed, columnsWords, gapsWords, execH2, execUnit, leftOutNamada, leftOutPool, minuteCostWords, notReadPool, orderWhat, pairUnnamed, poolWord, positionWhat, rangeWhat, recordedSince, sizeWords,
} from '../../../../shared/depth';
import { HEAT_STEP_MS, decodeHeat, slotColumns, type LinePoint } from '../../../../shared/depth-heat';
import { AddrName, Button, HeatChart, Notice, Segmented, SkeletonBlock, SourceLine, useMinWidth, type ScopeItem, type Stamp } from '../../ui/index';
import { fmtAge, fmtDayClock, fmtNamRule, fmtSig, fmtUsdRule, fmtUtcLong } from '../../lib/format';
import { ExecLine } from './ExecLine';
import { FLOW_INDEX_SOURCE, useDepthHeat, useDepthHistoryWindow, type ChangesWindow, type TradesWeek } from './data';
import { priceRange, provStamp, tradeMarks } from './model';

export interface OverProps {
  /** The live minute (its cost and its pools), or null under Rewind. */
  d: DepthResponse | null;
  /** The minute's own stamp, for the cost line's scope. */
  stamp: Stamp | null;
  symbol: string;
  /** The rewound moment, or null. */
  at: number | null;
  trades: { data: TradesWeek | null; error: string | null };
  changes: { data: ChangesWindow | null; error: string | null };
  headingId: string;
}

type Days = (typeof HEAT_RANGES)[number]['value'];
const CHANGES_SHOWN = 40;
const fmtKb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
/** The phone rule: a day is drawn in five-minute columns under this width. */
const WIDE_PX = 1024;

/** The change row as the words say it: what changed, the verb, the pool, and its size. */
export function changeParts(r: DepthChangeRow, symbol: string): { clock: string; what: string; verb: string; pool: string; size: string } {
  const [kind, id] = r.ref.split(':');
  const lo = r.loUsd != null ? fmtSig(r.loUsd) : '—', hi = r.hiUsd != null ? fmtSig(r.hiUsd) : '—';
  const what = kind === 'pos' ? positionWhat(id, priceRange(r.loUsd, r.hiUsd)) : kind === 'ord' ? orderWhat(id, r.side, lo) : kind === 'rng' ? rangeWhat(lo, hi) : RESERVES_WHAT;
  const size = r.nam != null && r.usd != null ? sizeWords(fmtNamRule(r.nam), symbol, fmtUsdRule(r.usd)) : r.usd != null ? fmtUsdRule(r.usd) : r.nam != null ? `${fmtNamRule(r.nam)} ${symbol}` : CHANGE_NO_SIZE;
  return { clock: fmtDayClock(r.ts), what, verb: CHANGE_VERBS[r.kind], pool: poolWord(r.pool, kind === 'ord' ? 'cosmwasm' : null), size };
}

export function Over({ d, stamp, symbol, at, trades, changes, headingId }: OverProps) {
  const wide = useMinWidth(WIDE_PX);
  const [days, setDays] = useState<Days>(() => (wide ? '7' : '1'));
  const [table, setTable] = useState(false);
  const nDays = Number(days);
  const heat = useDepthHeat(nDays, at);
  const hist = useDepthHistoryWindow(nDays, at);
  const h = heat.data;
  const apiStep = h?.step ?? (nDays === 1 ? '1m' : nDays === 7 ? '5m' : '1h');
  // the phone draws the day in five-minute columns: the last stored minute of each five, as the Worker's own week read does
  const step: '1m' | '5m' | '1h' = apiStep === '1m' && !wide ? '5m' : apiStep;
  const stepMs = HEAT_STEP_MS[step];
  const columns = useMemo(() => (h ? decodeHeat(h.columns) : []), [h]);
  const from = h?.from ?? (at ?? Date.now()) - nDays * 86_400_000;
  const to = h?.to ?? (at ?? Date.now());
  const slots = useMemo(() => slotColumns(columns, stepMs, from, to), [columns, stepMs, from, to]);
  const blank = slots.filter((s) => s == null).length;
  // the route's words for the day say one column per stored minute; drawn in fives, the sentence says fives (the route's note on bandless rows, if any, is kept)
  const how = h ? (apiStep === '1m' && !wide ? h.how.replace(HEAT_HOW['1m'], HEAT_HOW['5m']) : h.how) : '';
  const tw = trades.data;
  const marks = useMemo(() => (tw ? tradeMarks(tw.rows, tw.since) : []), [tw]);

  // the executable line: the quotable size's figure at every step of the window, null where no row was stored
  const quotableIdx = Math.max(0, (d?.answer.sizes ?? [1000, DEPTH_QUOTABLE_SIZE]).indexOf(DEPTH_QUOTABLE_SIZE));
  const hourly = hist.data?.step === '1h';
  const lineStep = hourly ? HEAT_STEP_MS['1h'] : HEAT_STEP_MS['1m'];
  const linePoints = useMemo((): LinePoint[] => {
    if (!hist.data) return [];
    const by = new Map<number, LinePoint>();
    for (const p of hist.data.points) by.set(p.t, { t: p.t, v: p.sell[quotableIdx] ?? null, lo: p.hour?.sellLo ?? null, hi: p.hour?.sellHi ?? null });
    const out: LinePoint[] = [];
    const f = Math.ceil(hist.data.from / lineStep) * lineStep;
    for (let t = f; t < hist.data.to; t += lineStep) out.push(by.get(t) ?? { t, v: null });
    return out;
  }, [hist.data, quotableIdx, lineStep]);

  // the stretches with no stored row, as the history answer lists them: the count and the longest, said under the line
  const gaps = useMemo(() => {
    const g = hist.data?.gaps ?? [];
    if (!g.length) return null;
    return { n: g.length, longest: g.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a)) };
  }, [hist.data]);

  // the change rows inside this window, newest first
  const cw = changes.data;
  const rows = useMemo(() => (cw ? cw.rows.filter((r) => r.ts >= from && r.ts <= to) : []), [cw, from, to]);

  // the sources behind the band
  const heatStamp: Stamp | null = h?.prov[0] ? provStamp(h.prov[0]) : null;
  const histStamp: Stamp | null = hist.data?.prov[0] ? provStamp(hist.data.prov[0]) : null;
  const changesStamp: Stamp | null = cw?.prov[0] ? provStamp(cw.prov[0]) : null;
  const tradesStamp: Stamp | null = tw ? { ...tw.prov, plain: FLOW_INDEX_PLAIN } : trades.error ? { source: FLOW_INDEX_SOURCE, plain: FLOW_INDEX_PLAIN, at: null, status: 'missing', note: trades.error } : null;
  const sources: ScopeItem[] = [
    { label: SOURCE_HEAT, p: heatStamp ?? { source: SOURCE_HEAT, at: null, status: 'missing', note: heat.error ?? HEAT_WAITS } },
    { label: hourly ? SOURCE_HOURS : SOURCE_EXEC, p: histStamp ?? { source: SOURCE_EXEC, at: null, status: 'missing', note: hist.error ?? HEAT_WAITS } },
    { label: SOURCE_CHANGES, p: changesStamp ?? { source: SOURCE_CHANGES, at: null, status: 'missing', note: changes.error ?? CHANGES_NONE } },
    ...(tradesStamp ? [{ label: SOURCE_STORED_TRADES, p: tradesStamp }] : []),
  ];

  const notRead = d ? d.pools.filter((p) => 'error' in p.read) : [];
  // a pair whose counter coin has no symbol carries its raw denomination in the list; the page says so in words instead
  const pairOf = (pair: string) => (/\b(ibc|factory)\//.test(pair) ? pairUnnamed(symbol) : pair);
  const leftOut = d ? [...d.unpriced.map((u) => leftOutPool(poolWord(u.id, null), pairOf(u.pair), u.why)), ...notRead.map((p) => notReadPool(poolWord(p.id, p.type), pairOf(p.pair), 'error' in p.read ? p.read.error : ''))] : [];

  return (
    <div className="dp-over" data-prov-scope="">
      <h2 id={headingId} className="h2">{OVER_H2}</h2>
      <div className="dp-ctl">
        <Segmented label={LABEL_WINDOW} variant="range" value={days} onChange={setDays} options={HEAT_RANGES.map((r) => ({ value: r.value, label: r.label }))} />
        <Button size="sm" aria-pressed={table} onClick={() => setTable((v) => !v)}>{table ? CHART_VIEW : TABLE_VIEW}</Button>
      </div>
      {h ? (
        columns.length ? (
          <>
            <HeatChart columns={columns} stepMs={stepMs} from={from} to={to} edges={HEAT_EDGES} symbol={symbol} refPool={hist.data?.refPool ?? d?.ref.pool ?? ''} trades={tw ? marks : null} tradesDays={CURVE_TRADES_DAYS} table={table} />
            <p className="cap dp-over__cols">{columnsWords(slots.length, HEAT_STEP_WORDS[step], blank)}; {how}.{!wide && apiStep === '1m' ? ` ${PHONE_FIVE}` : ''}</p>
          </>
        ) : (
          <Notice tone="info" title={HEAT_NONE} />
        )
      ) : heat.error ? (
        <Notice tone="warning" title={heat.error}>{HEAT_WAITS}</Notice>
      ) : (
        <div className="dp-bookskel" aria-busy="true" role="status" aria-label={HEAT_WAITS}><SkeletonBlock height={260} /></div>
      )}
      {hist.data?.recordedSince != null ? <p className="cap dp-over__start">{recordedSince(fmtUtcLong(hist.data.recordedSince))}</p> : null}
      {hist.data ? (
        <>
          <ExecLine points={linePoints} stepMs={lineStep} from={from} to={to} hourly={!!hourly} heading={execH2(fmtNamRule(DEPTH_QUOTABLE_SIZE), symbol)} nam={fmtNamRule(DEPTH_QUOTABLE_SIZE)} symbol={symbol} unit={execUnit(symbol)} headingId={`${headingId}-exec`} />
          <p className="cap dp-exec__gaps">{gaps ? gapsWords(gaps.n, fmtAge(gaps.longest.to - gaps.longest.from), fmtDayClock(gaps.longest.from)) : GAPS_NONE}</p>
        </>
      ) : hist.error ? (
        <Notice tone="warning" title={hist.error} />
      ) : null}
      <section className="dp-changes" aria-labelledby={`${headingId}-changes`}>
        <h3 id={`${headingId}-changes`} className="h3">{CHANGES_H3}</h3>
        <p className="cap dp-lead">{CHANGES_LEAD}</p>
        {cw ? (
          rows.length ? (
            <>
              <p className="cap dp-changes__count">{cw.cut ? changesAtLeast(rows.length) : changesInWindow(rows.length)}{rows.length > CHANGES_SHOWN || cw.cut ? ` (${changesListed(Math.min(rows.length, CHANGES_SHOWN))})` : ''}</p>
              <ol className="dp-changes__list">
                {rows.slice(0, CHANGES_SHOWN).map((r) => {
                  const c = changeParts(r, symbol);
                  return (
                    <li key={`${r.ts}:${r.pool}:${r.ref}`} data-kind={r.kind}>
                      <span>{changeHead(c.clock, c.what, c.verb, c.pool)}</span>
                      {r.owner ? <> {BY_WORD} <AddrName address={r.owner} className="dp-changes__owner" /></> : null}
                      <span>: <b data-num="">{c.size}</b></span>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <p className="cap">{CHANGES_NONE}</p>
          )
        ) : changes.error ? (
          <p className="cap">{changes.error}</p>
        ) : null}
      </section>
      <SourceLine items={sources} label={SOURCE_OVER} />
      {d && stamp ? (
        <div className="dp-cost" data-prov-scope="">
          <h3 className="h3">{COST_LABEL}</h3>
          <p className="cap"><b data-num="">{minuteCostWords(d.cost.reads, fmtKb(d.cost.bytes), fmtMs(d.cost.ms))}</b> {COST_CAPS}</p>
          <h3 className="h3">{LEFT_OUT_LABEL}</h3>
          <ul className="dp-leftout">
            {leftOut.length ? leftOut.map((w) => <li key={w}>{w}</li>) : <li>{LEFT_OUT_NONE}</li>}
            <li>{leftOutNamada(symbol)}</li>
          </ul>
          <SourceLine items={[{ label: COST_LABEL, p: stamp }]} label={COST_LABEL} />
        </div>
      ) : null}
    </div>
  );
}

export default Over;
