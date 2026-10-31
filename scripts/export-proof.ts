/**
 * W4: build-time export of the dated proof block and the chart event markers.
 *
 *   node --experimental-strip-types scripts/export-proof.ts      (npm run gen)
 *
 * Reads docs/replay-report.md (written by test/replay.test.ts) and docs/events.json (written by
 * scripts/events.ts) and writes web/src/generated/proof.ts and web/src/generated/events.ts. Every figure in
 * the output is parsed from those two files, and the ones that appear in both are checked against each
 * other: the script stops instead of writing a figure the sources do not agree on.
 *
 * Owner decision 10: the owner's own trades never become public. Events of type "trade" (and report rows
 * marked "(own)") are left out of both outputs, including from every count.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateFlows, type AlertThresholds } from '../shared/alerts.ts';
import type { Flow } from '../shared/types.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = 3600000;

// ---------------------------------------------------------------- the report

export interface ReportRow { id: string; move: string; rules: string[]; firstAlert: string | null; leadH: number | null; exactTimes: boolean; own: boolean }

export interface Report {
  generated: string;           // "2026-10-17 11:57" (UTC)
  generatedAt: number;         // unix ms
  events: number;              // every event in the report, own trades included (not exported)
  pricePoints: number;
  thresholds: AlertThresholds;
  flagged: number;
  priceMoves: number;
  medianLeadH: number | null;
  leadRangeH: [number, number] | null;
  windowH: number;
  baseRatePct: number | null;
  minAlertNam: number | null;
  rows: ReportRow[];
}

const num = (s: string) => Number(s.replace(/,/g, ''));
const minuteMs = (s: string) => {
  const t = Date.parse(`${s.replace(' ', 'T')}:00Z`);
  if (!Number.isFinite(t)) throw new Error(`not a UTC minute: ${s}`);
  return t;
};

function need<T>(v: T | null | undefined, what: string): T {
  if (v == null) throw new Error(`replay report: ${what} not found`);
  return v;
}

export function parseReport(md: string): Report {
  const gen = need(/^Generated (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC by .*?\((\d+) events, (\d+) price points\) with default thresholds (\{[^}]*\})\.$/m.exec(md), 'the "Generated" line');
  const flag = need(/\*\*Price moves flagged ahead of time: (\d+) \/ (\d+)\.\*\* Median lead (—|[\d.]+ h); range (—|([\d.]+)–([\d.]+) h)\./.exec(md), 'the flagged line');
  const win = need(/fired on a flow in the (\d+)h before the move completed/.exec(md), 'the window');
  const base = /\*\*Base rate:\*\* (\d+)% of all price points had an alert-size flow \(≥ ([\d,]+) NAM\) in the prior (\d+)h/.exec(md);
  if (base && Number(base[3]) !== Number(win[1])) throw new Error(`replay report: base-rate window ${base[3]}h differs from the flag window ${win[1]}h`);

  const rows: ReportRow[] = [];
  const table = md.slice(md.indexOf('| event | move |'));
  for (const line of table.split('\n').slice(2)) {
    if (!line.startsWith('|')) break;
    const c = line.split('|').slice(1, -1).map((x) => x.trim());
    if (c.length !== 6) throw new Error(`replay report: bad table row: ${line}`);
    rows.push({
      id: c[0], move: c[1],
      rules: c[2] === '_none_' ? [] : c[2].split(',').map((r) => r.trim()),
      firstAlert: c[3] === '—' ? null : c[3],
      leadH: c[4] === '—' ? null : Number(c[4].replace(/ h$/, '')),
      exactTimes: c[5] === 'yes',
      own: /\(own\)/.test(c[1]),
    });
  }
  return {
    generated: gen[1], generatedAt: minuteMs(gen[1]),
    events: Number(gen[2]), pricePoints: Number(gen[3]), thresholds: JSON.parse(gen[4]) as AlertThresholds,
    flagged: Number(flag[1]), priceMoves: Number(flag[2]),
    medianLeadH: flag[3] === '—' ? null : Number(flag[3].replace(/ h$/, '')),
    leadRangeH: flag[5] ? [Number(flag[5]), Number(flag[6])] : null,
    windowH: Number(win[1]),
    baseRatePct: base ? Number(base[1]) : null, minAlertNam: base ? num(base[2]) : null,
    rows,
  };
}

// ---------------------------------------------------------------- events.json

interface EventsFile { generatedAt: number; pricePoints: number; baseRate?: number | null; minAlertNam?: number; events: any[] }

/** The same conversion test/replay.test.ts uses, so the first-alert time is computed exactly as the report's. */
const toFlow = (s: any): Flow => ({
  id: s.id, chain: s.chain, height: 0, ts: s.ts, txHash: s.id.split(':')[1] ?? '', kind: s.kind,
  from: s.from, to: s.to, amount: s.amountNam, fromLabel: s.fromLabel, toLabel: s.toLabel,
  meta: { arb: s.arb, tsSource: s.tsSource },
});

const isoMinute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export interface Proof {
  reportDate: string;            // "2026-10-17" (UTC)
  reportGeneratedAt: number;
  marketEventsTested: number;
  pricePoints: number;
  priceMovesFlagged: number;
  priceMovesTested: number;
  medianLeadHours: number | null;
  leadRangeHours: [number, number] | null;
  windowHours: number;
  baseRatePct: number | null;
  minAlertNam: number | null;
  thresholds: AlertThresholds;
  rewindExample: {
    eventId: string;
    /** 'withdraw': unlocked and withdrawn from staking by a holder; 'pos_balance': the staking account's own balance
     *  moved in one transfer (not a holder's withdrawal: docs/design/screener-plan.md 3.0, owner decision 3) */
    kind: 'withdraw' | 'pos_balance';
    amountNam: number;
    at: number;                  // the move's block time
    firstAlertAt: number;        // the first alert in the window before it (exact, from events.json)
    firstAlertRule: string;
    leadHours: number;
    rewindAt: number;            // firstAlertAt + 1 ms: rewound there, that alert is the newest one shown
    txHash: string;
  } | null;
}

/** The staking account (shared/alerts.ts INTERNAL_ADDRESSES.pos). */
const POS = 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp';

export function buildProof(r: Report, ev: EventsFile): Proof {
  const market = ev.events.filter((e) => e.type === 'price_move' || e.type === 'whale_flow');
  const marketRows = r.rows.filter((x) => !x.own);
  if (market.length !== marketRows.length) throw new Error(`events.json has ${market.length} market events, the report ${marketRows.length} rows`);
  if (ev.pricePoints !== r.pricePoints) throw new Error(`price points: events.json ${ev.pricePoints}, report ${r.pricePoints}`);
  const priceRows = r.rows.filter((x) => x.id.startsWith('price_'));
  if (priceRows.length !== r.priceMoves) throw new Error(`report lists ${priceRows.length} price moves but says ${r.priceMoves}`);
  if (priceRows.filter((x) => x.rules.length > 0).length !== r.flagged) throw new Error('report flag count does not match its table');

  // The Rewind example (owner decision 3): the largest move of NAM out of the staking account among the market
  // events, and the first alert before it. Since 2026-10-20 the 331 million NAM of 31 Aug 2026 is filed as what it
  // was, a transfer of the staking account's own balance ('pos_balance'), not a withdrawal by a holder; the
  // sentence says which kind it is (Home, Palette).
  const outs = market.filter((e) => e.type === 'whale_flow' && (e.flow?.kind === 'withdraw' || (e.flow?.kind === 'pos_balance' && e.flow?.from === POS)))
    .sort((a, b) => b.flow.amountNam - a.flow.amountNam);
  let example: Proof['rewindExample'] = null;
  if (outs.length) {
    const w = outs[0];
    const row = need(r.rows.find((x) => x.id === w.id), `row ${w.id}`);
    const hits = evaluateFlows(w.leadSignals.map(toFlow), r.thresholds).filter((h) => h.ts < w.t1);
    if (!hits.length || !row.firstAlert || row.leadH == null) throw new Error(`no alert before ${w.id}`);
    const first = hits.reduce((a, h) => (h.ts < a.ts ? h : a));
    if (isoMinute(first.ts) !== row.firstAlert) throw new Error(`first alert for ${w.id}: events.json ${isoMinute(first.ts)}, report ${row.firstAlert}`);
    const amt = /^(withdraw|pos_balance) ([\d,]+)/.exec(row.move);
    if (!amt || amt[1] !== w.flow.kind || num(amt[2]) !== Math.round(w.flow.amountNam)) throw new Error(`move amount for ${w.id}: report "${row.move}", events.json ${w.flow.kind} ${w.flow.amountNam}`);
    if (Math.abs((w.t1 - first.ts) / H - row.leadH) > 0.051) throw new Error(`lead for ${w.id}: report ${row.leadH} h`);
    example = {
      eventId: w.id, kind: w.flow.kind, amountNam: w.flow.amountNam, at: w.flow.ts, firstAlertAt: first.ts, firstAlertRule: first.ruleId,
      leadHours: row.leadH, rewindAt: first.ts + 1, txHash: String(w.flow.id).split(':')[1] ?? '',
    };
  }

  return {
    reportDate: r.generated.slice(0, 10), reportGeneratedAt: r.generatedAt,
    marketEventsTested: market.length, pricePoints: r.pricePoints,
    priceMovesFlagged: r.flagged, priceMovesTested: r.priceMoves,
    medianLeadHours: r.medianLeadH, leadRangeHours: r.leadRangeH, windowHours: r.windowH,
    baseRatePct: r.baseRatePct, minAlertNam: r.minAlertNam, thresholds: r.thresholds,
    rewindExample: example,
  };
}

export interface PriceMoveMarker { id: string; t0: number; t1: number; pct: number; priceBefore: number; priceAfter: number }
export interface LargeFlowMarker { id: string; chain: 'namada' | 'osmosis'; ts: number; kind: string; amountNam: number; txHash: string; pct24h: number | null; pct72h: number | null }

export function buildMarkers(ev: EventsFile): { priceMoves: PriceMoveMarker[]; largeFlows: LargeFlowMarker[] } {
  // Belt and braces for owner decision 10: a large flow from or to an address of the owner's trades is left out too.
  const own = new Set(ev.events.filter((e) => e.type === 'trade').map((e) => e.trade?.address).filter(Boolean));
  const priceMoves = ev.events.filter((e) => e.type === 'price_move')
    .map((e): PriceMoveMarker => ({ id: e.id, t0: e.t0, t1: e.t1, pct: e.pct, priceBefore: e.priceBefore, priceAfter: e.priceAfter }))
    .sort((a, b) => a.t1 - b.t1);
  const largeFlows = ev.events.filter((e) => e.type === 'whale_flow' && !own.has(e.flow?.from) && !own.has(e.flow?.to))
    .map((e): LargeFlowMarker => ({
      id: e.id, chain: e.flow.chain, ts: e.flow.ts, kind: e.flow.kind, amountNam: e.flow.amountNam,
      txHash: String(e.flow.id).split(':')[1] ?? '', pct24h: e.pct24h ?? null, pct72h: e.pct72h ?? null,
    }))
    .sort((a, b) => a.ts - b.ts);
  return { priceMoves, largeFlows };
}

// ---------------------------------------------------------------- output

const HEADER = (from: string) => `// GENERATED by scripts/export-proof.ts (npm run gen) from ${from}. Do not edit by hand.
// Every figure here is parsed from those files and cross-checked between them (N2). The owner's own trades
// are not included (owner decision 10).
`;

const lit = (v: unknown) => JSON.stringify(v, null, 2);

export function renderProofTs(p: Proof): string {
  return `${HEADER('docs/replay-report.md and docs/events.json')}
/** The dated proof block: the alert rules replayed against past market events (docs/replay-report.md). */
export interface Proof {
  /** day the report was generated (UTC), shown with the block */
  reportDate: string;
  reportGeneratedAt: number;
  /** price moves and large flows the rules were replayed against */
  marketEventsTested: number;
  /** hourly executed-swap prices the price moves were found in */
  pricePoints: number;
  /** price moves with an alert-size flow in the window before them, of priceMovesTested */
  priceMovesFlagged: number;
  priceMovesTested: number;
  /** median hours between the first alert and the move */
  medianLeadHours: number | null;
  leadRangeHours: [number, number] | null;
  /** hours before a move in which an alert counts */
  windowHours: number;
  /** share of all price points that had an alert-size flow in the window before them: the base rate */
  baseRatePct: number | null;
  /** smallest alert size used for the base rate (NAM) */
  minAlertNam: number | null;
  // the replay report's own sizes: a report generated before the sixth rule (2026-10-30) has none for it
  thresholds: { ibcInventory: number; unlock: number; bigSwap: number; unshield: number; bond: number; exitBridge?: number };
  /** the Rewind example: the largest move out of the staking account and the first alert before it */
  rewindExample: {
    eventId: string;
    /** 'withdraw': withdrawn from staking by a holder; 'pos_balance': the staking account's own balance moved in one transfer */
    kind: 'withdraw' | 'pos_balance';
    amountNam: number;
    /** block time of the move */
    at: number;
    /** time of the first alert in the window before it */
    firstAlertAt: number;
    firstAlertRule: string;
    leadHours: number;
    /** link target: /supply?at=<rewindAt> shows that alert as the newest */
    rewindAt: number;
    txHash: string;
  } | null;
}

export const PROOF: Proof = ${lit(p)};
`;
}

export function renderEventsTs(m: { priceMoves: PriceMoveMarker[]; largeFlows: LargeFlowMarker[] }, generatedAt: number): string {
  return `${HEADER('docs/events.json')}
/** When docs/events.json was built from the database (unix ms). */
export const EVENTS_GENERATED_AT = ${generatedAt};

/** The largest hour-to-hour moves in the executed-swap price: chart markers. */
export interface PriceMoveMarker {
  id: string;
  /** the two hourly price points the move is measured between (unix ms) */
  t0: number;
  t1: number;
  /** signed percent */
  pct: number;
  priceBefore: number;
  priceAfter: number;
}

/** The largest single on-chain moves of NAM, with the price change over the next 24 and 72 hours. */
export interface LargeFlowMarker {
  id: string;
  chain: 'namada' | 'osmosis';
  ts: number;
  kind: string;
  amountNam: number;
  txHash: string;
  pct24h: number | null;
  pct72h: number | null;
}

export const PRICE_MOVES: PriceMoveMarker[] = ${lit(m.priceMoves)};

export const LARGE_FLOWS: LargeFlowMarker[] = ${lit(m.largeFlows)};
`;
}

export function exportProof(root = ROOT): { proof: Proof; files: string[] } {
  const md = readFileSync(join(root, 'docs', 'replay-report.md'), 'utf8');
  const ev = JSON.parse(readFileSync(join(root, 'docs', 'events.json'), 'utf8')) as EventsFile;
  const proof = buildProof(parseReport(md), ev);
  const out = join(root, 'web', 'src', 'generated');
  mkdirSync(out, { recursive: true });
  const files = [join(out, 'proof.ts'), join(out, 'events.ts')];
  writeFileSync(files[0], renderProofTs(proof));
  writeFileSync(files[1], renderEventsTs(buildMarkers(ev), ev.generatedAt));
  return { proof, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { proof, files } = exportProof();
  console.log(`report of ${proof.reportDate}: ${proof.priceMovesFlagged}/${proof.priceMovesTested} price moves flagged, ${proof.marketEventsTested} market events`);
  for (const f of files) console.log(`wrote ${f.slice(ROOT.length + 1)}`);
}
