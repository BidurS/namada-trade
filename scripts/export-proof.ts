/**
 * W4: build-time export of the dated proof block, the chart event markers, the incidents timeline and the
 * NAM-supply split since genesis.
 *
 *   node --experimental-strip-types scripts/export-proof.ts      (npm run gen)
 *
 * Reads docs/replay-report.md (written by test/replay.test.ts) and docs/events.json (written by
 * scripts/events.ts) and writes web/src/generated/proof.ts and web/src/generated/events.ts. Every figure in
 * the output is parsed from those two files, and the ones that appear in both are checked against each
 * other: the script stops instead of writing a figure the sources do not agree on. events.ts also carries
 * INCIDENTS, the reviewed rows of scripts/incidents.ts, while the timeline is shown (none while it is hidden:
 * shippedIncidents), each checked for a source and a well-formed date.
 * web/src/generated/supply.ts is the dated split of NAM minted since genesis, read from docs/data (the
 * per-epoch table and the period totals, re-derived from public figures on 2026-11-02), each period's total
 * checked against the table's rows. No network: everything here is read from files in the repository.
 *
 * Owner decision 10: the owner's own trades never become public. Events of type "trade" (and report rows
 * marked "(own)") are left out of both outputs, including from every count.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluateFlows, type AlertThresholds } from '../shared/alerts.ts';
import type { Flow } from '../shared/types.ts';
import { INCIDENTS, type Incident } from './incidents.ts';
import { TIMELINE_SHOWN } from '../shared/timeline-flag.ts';

/**
 * The timeline's rows as the site ships them: all of them while the timeline is shown, none while it is hidden
 * (shared/copy.ts TIMELINE_SHOWN), so a hidden timeline's text is not in the files a browser downloads. The rows stay
 * in scripts/incidents.ts with their tests; showing the timeline again is the flag and `npm run gen`.
 */
export const shippedIncidents = (rows: Incident[]): Incident[] => (TIMELINE_SHOWN ? rows : []);

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
  // events that an alert came before, and that first alert. The 331 million NAM of 31 Aug 2026 it used to name was
  // the staking-account exploit (owner, 2026-11-02; migrations/0019_exploit_labels.sql), which scripts/events.ts no
  // longer counts as a market event; a move with no alert before it cannot show what an alert gave, so it is passed.
  const outs = market.filter((e) => e.type === 'whale_flow' && (e.flow?.kind === 'withdraw' || (e.flow?.kind === 'pos_balance' && e.flow?.from === POS)))
    .filter((e) => r.rows.find((x) => x.id === e.id)?.firstAlert)
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
  thresholds: { ibcInventory: number; unlock: number; bigSwap: number; unshield: number; bond: number; exitBridge?: number; liquidity?: number };
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

// ---------------------------------------------------------------- the incidents timeline (scripts/incidents.ts)

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The chart label's longest form (web/src/ui/PriceChart.tsx cuts a longer one). */
export const INCIDENT_MARK_MAX = 12;

/**
 * The rows as the page may show them: unique ids, UTC days, a moment on the row's day, a title, a text, at least one
 * source a reader can open (an https URL), a mark a chart can print, measured halts with their blocks in order, and
 * the rows themselves in time order. Throws on the first row that is not so, naming it.
 */
export function checkIncidents(rows: Incident[]): Incident[] {
  const ids = new Set<string>();
  let last = -Infinity;
  for (const r of rows) {
    const where = `incident ${r.id || '(no id)'}`;
    if (!r.id || ids.has(r.id)) throw new Error(`${where}: id missing or repeated`);
    ids.add(r.id);
    if (!DAY_RE.test(r.date) || (r.end != null && !DAY_RE.test(r.end))) throw new Error(`${where}: date is not a UTC day`);
    if (!Number.isFinite(r.at) || dayOf(r.at) !== r.date) throw new Error(`${where}: at (${Number.isFinite(r.at) ? dayOf(r.at) : r.at}) is not on its day ${r.date}`);
    if (r.end != null && r.end < r.date) throw new Error(`${where}: ends before it starts`);
    if (r.at < last) throw new Error(`${where}: out of time order`);
    last = r.at;
    if (!r.title.trim() || !r.text.trim()) throw new Error(`${where}: title or text missing`);
    if (!r.sources.length || !r.sources.some((s) => s.url)) throw new Error(`${where}: no source a reader can open`);
    for (const s of r.sources) {
      if (!s.label.trim()) throw new Error(`${where}: a source has no words`);
      if (s.url != null && !/^https:\/\/[^\s]+$/.test(s.url)) throw new Error(`${where}: source "${s.label}" is not an https URL`);
    }
    if (r.mark != null && (!r.mark.trim() || r.mark.length > INCIDENT_MARK_MAX)) throw new Error(`${where}: mark "${r.mark}" is empty or over ${INCIDENT_MARK_MAX} characters`);
    for (const h of r.halts ?? []) {
      if (!(h.to === h.from + 1) || !(h.hours > 0) || !Number.isFinite(h.hours)) throw new Error(`${where}: halt ${h.from} to ${h.to} is not two consecutive blocks with hours between them`);
    }
    for (const p of r.pages) if (!/^\/[a-z-]*$/.test(p)) throw new Error(`${where}: page "${p}" is not a route path`);
  }
  return rows;
}

// ---------------------------------------------------------------- NAM supply since genesis (docs/data)

/** The period totals and fixed facts of docs/data/supply_since_genesis.json, as written there (NAM as decimal strings). */
export interface SupplyPeriodsFile {
  derivedOn: string;
  source: string;
  genesis: { nam: string; source: string };
  mintedAt: { epoch: number; fromBlock: number; toBlock: number; nam: string; source: string };
  epochStarts: { epoch: number; block: number; day: string }[];
  inflationFromEpoch: number;
  publicFundingRateZeroFromEpoch: number;
  before: { fromEpoch: number; toEpoch: number; observedNam: string; note: string };
  periods: { fromEpoch: number; toEpoch: number; observedNam: string; stakingNam: string; publicFundingNam: string; indexerRows: number }[];
  publicFundingTransfer: { nam: string; block: number; at: string; txHash: string; note: string };
}

/** One row of docs/data/supply_by_epoch_1207_2737.tsv, in micro-NAM as integers. */
export interface SupplyEpochRow { epoch: number; maspEpoch: boolean; observed: bigint; staking: bigint; publicFunding: bigint; residual: bigint }

const MICRO = 1_000_000n;
/** A decimal NAM string ("1148734527.288587", "0") as micro-NAM. */
export function microOf(nam: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(nam.trim());
  if (!m) throw new Error(`not a NAM amount: "${nam}"`);
  const v = BigInt(m[2]) * MICRO + BigInt((m[3] ?? '').padEnd(6, '0'));
  return m[1] ? -v : v;
}
const namOf = (micro: bigint) => Number(micro) / 1e6;

export function parseSupplyTsv(tsv: string): SupplyEpochRow[] {
  const lines = tsv.trim().split('\n');
  const head = lines[0].split('\t');
  const col = (name: string) => {
    const i = head.findIndex((h) => h === name || h.startsWith(`${name}(`));
    if (i < 0) throw new Error(`supply table: no column ${name}`);
    return i;
  };
  const cEpoch = col('epoch'), cMasp = col('masp_epoch'), cObs = col('observed_mint_microNAM'), cPos = col('pos_pred_microNAM'), cPgf = col('pgf_pred_microNAM'), cRes = col('residual_microNAM');
  const rows: SupplyEpochRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split('\t');
    const r: SupplyEpochRow = { epoch: Number(c[cEpoch]), maspEpoch: c[cMasp] === '1', observed: BigInt(c[cObs]), staking: BigInt(c[cPos]), publicFunding: BigInt(c[cPgf]), residual: BigInt(c[cRes]) };
    if (!Number.isInteger(r.epoch) || (rows.length && r.epoch <= rows[rows.length - 1].epoch)) throw new Error(`supply table: epoch "${c[cEpoch]}" out of order`);
    rows.push(r);
  }
  return rows;
}

/** What web/src/generated/supply.ts carries (the Supply page's dated split; its live figures come from the API). */
export interface SupplySplit {
  /** the day the split was re-derived from public figures (UTC), and that day as unix ms */
  derivedOn: string;
  derivedAt: number;
  source: string;
  genesisNam: number;
  /** the epochs the split covers, their first and last blocks and the first's day */
  fromEpoch: number;
  toEpoch: number;
  fromBlock: number;
  toBlock: number;
  fromDay: string;
  /** the minted total at the last epoch covered */
  mintedAtToEpochNam: number;
  /** staking inflation and public-funding inflation over the epochs covered */
  stakingNam: number;
  publicFundingNam: number;
  /** epochs covered, and how many of them the indexer has a figure for; the rest were carried across by the formulas */
  epochs: number;
  measuredEpochs: number;
  /** the one stretch with no indexer figure at all: its epochs, days and the staking inflation modelled over it */
  modelled: { fromEpoch: number; toEpoch: number; fromDay: string; toDay: string; stakingNam: number };
  /** the one large transfer into the public-funding account: moved, not minted */
  transfer: { nam: number; block: number; at: number; txHash: string };
}

/**
 * The split from the two files, each period's totals checked against the table's rows: a period's rows add up to no
 * more than its total (the epochs the indexer lacks were carried across), and the periods together are exactly the
 * growth from genesis less the growth before the first period. Throws on the first figure that does not hold.
 */
export function buildSupplySplit(file: SupplyPeriodsFile, rows: SupplyEpochRow[]): SupplySplit {
  const periods = [...file.periods].sort((a, b) => a.fromEpoch - b.fromEpoch);
  if (!periods.length) throw new Error('supply periods: none');
  for (let i = 1; i < periods.length; i++) if (periods[i].fromEpoch !== periods[i - 1].toEpoch + 1) throw new Error(`supply periods: a gap or overlap before epoch ${periods[i].fromEpoch}`);
  const fromEpoch = periods[0].fromEpoch, toEpoch = periods[periods.length - 1].toEpoch;
  if (file.before.toEpoch + 1 !== fromEpoch) throw new Error('supply periods: the period before does not end where the first period starts');
  if (file.mintedAt.epoch !== toEpoch) throw new Error(`supply periods: the minted total is at epoch ${file.mintedAt.epoch}, the periods end at ${toEpoch}`);
  if (rows.length && (rows[0].epoch < fromEpoch || rows[rows.length - 1].epoch > toEpoch)) throw new Error('supply table: rows outside the periods');
  const growth = microOf(file.mintedAt.nam) - microOf(file.genesis.nam);
  let sumObserved = 0n, staking = 0n, publicFunding = 0n, measured = 0;
  let modelled: SupplySplit['modelled'] | null = null;
  const startOf = (epoch: number) => file.epochStarts.find((s) => s.epoch === epoch);
  for (const p of periods) {
    const inRows = rows.filter((r) => r.epoch >= p.fromEpoch && r.epoch <= p.toEpoch);
    if (inRows.length !== p.indexerRows) throw new Error(`supply period ${p.fromEpoch} to ${p.toEpoch}: ${inRows.length} rows in the table, ${p.indexerRows} said`);
    const sum = (f: (r: SupplyEpochRow) => bigint) => inRows.reduce((a, r) => a + f(r), 0n);
    const obs = microOf(p.observedNam), st = microOf(p.stakingNam), pf = microOf(p.publicFundingNam);
    if (sum((r) => r.observed) > obs) throw new Error(`supply period ${p.fromEpoch} to ${p.toEpoch}: the table's observed mint exceeds the period's`);
    if (sum((r) => r.staking) > st) throw new Error(`supply period ${p.fromEpoch} to ${p.toEpoch}: the table's staking inflation exceeds the period's`);
    if (sum((r) => r.publicFunding) > pf) throw new Error(`supply period ${p.fromEpoch} to ${p.toEpoch}: the table's public-funding inflation exceeds the period's`);
    sumObserved += obs; staking += st; publicFunding += pf; measured += inRows.length;
    if (inRows.length === 0) {
      if (modelled) throw new Error('supply periods: more than one stretch without indexer figures');
      const a = startOf(p.fromEpoch), b = startOf(p.toEpoch + 1);
      if (!a || !b) throw new Error(`supply periods: no epoch start recorded for epochs ${p.fromEpoch} and ${p.toEpoch + 1}`);
      modelled = { fromEpoch: p.fromEpoch, toEpoch: p.toEpoch, fromDay: a.day, toDay: b.day, stakingNam: namOf(st) };
    }
  }
  if (!modelled) throw new Error('supply periods: no stretch is marked as carried across (every period has rows)');
  const before = microOf(file.before.observedNam);
  if (sumObserved + before !== growth) throw new Error(`supply periods: the periods (${namOf(sumObserved)}) plus the growth before (${namOf(before)}) are not the growth from genesis (${namOf(growth)})`);
  const first = startOf(fromEpoch);
  if (!first) throw new Error(`supply periods: no epoch start recorded for epoch ${fromEpoch}`);
  const t = file.publicFundingTransfer;
  const at = Date.parse(t.at);
  if (!Number.isFinite(at) || !Number.isInteger(t.block) || !/^[0-9A-F]{64}$/.test(t.txHash)) throw new Error('supply transfer: block, time or hash malformed');
  const derivedAt = Date.parse(`${file.derivedOn}T00:00:00Z`);
  if (!DAY_RE.test(file.derivedOn) || !Number.isFinite(derivedAt)) throw new Error(`supply periods: derivedOn "${file.derivedOn}" is not a UTC day`);
  return {
    derivedOn: file.derivedOn, derivedAt, source: file.source,
    genesisNam: namOf(microOf(file.genesis.nam)),
    fromEpoch, toEpoch, fromBlock: first.block, toBlock: file.mintedAt.toBlock, fromDay: first.day,
    mintedAtToEpochNam: namOf(microOf(file.mintedAt.nam)),
    stakingNam: namOf(staking), publicFundingNam: namOf(publicFunding),
    epochs: toEpoch - fromEpoch + 1, measuredEpochs: measured,
    modelled,
    transfer: { nam: namOf(microOf(t.nam)), block: t.block, at, txHash: t.txHash },
  };
}

export function renderSupplyTs(s: SupplySplit): string {
  return `${HEADER('docs/data/supply_since_genesis.json and docs/data/supply_by_epoch_1207_2737.tsv')}
/**
 * NAM minted since genesis, split by what minted it, over the epochs the public record lets the split be made for:
 * re-derived from public figures on the day named (docs/data/README.md has the method and the coverage). The live
 * figures beside it (the minted total now, the chain's total of shielded rewards, the newest epoch's staking
 * inflation) come from the API, never from here.
 */
export interface SupplySplit {
  /** the day the split was re-derived (UTC), and that day as unix ms */
  derivedOn: string;
  derivedAt: number;
  source: string;
  genesisNam: number;
  /** the epochs the split covers, their first and last blocks and the first's day */
  fromEpoch: number;
  toEpoch: number;
  fromBlock: number;
  toBlock: number;
  fromDay: string;
  /** the minted total at the last epoch covered */
  mintedAtToEpochNam: number;
  /** staking inflation and public-funding inflation over the epochs covered */
  stakingNam: number;
  publicFundingNam: number;
  /** epochs covered, and how many of them the indexer has a figure for; the rest were carried across by the formulas */
  epochs: number;
  measuredEpochs: number;
  /** the one stretch with no indexer figure at all: its epochs, days and the staking inflation modelled over it */
  modelled: { fromEpoch: number; toEpoch: number; fromDay: string; toDay: string; stakingNam: number };
  /** the one large transfer into the public-funding account: moved, not minted */
  transfer: { nam: number; block: number; at: number; txHash: string };
}

export const SUPPLY_SPLIT: SupplySplit = ${lit(s)};
`;
}

export function renderEventsTs(m: { priceMoves: PriceMoveMarker[]; largeFlows: LargeFlowMarker[] }, generatedAt: number, incidents: Incident[]): string {
  return `${HEADER('docs/events.json and scripts/incidents.ts')}
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

/** A source of an incident row: the link's words and its page; a statement with no page of its own has no url. */
export interface IncidentSource {
  label: string;
  url?: string;
}

/** A stretch without blocks: the last block before it, the first after it, and the hours between their header times. */
export interface IncidentHalt {
  from: number;
  to: number;
  hours: number;
}

/**
 * One row of the public incidents timeline (scripts/incidents.ts): what happened on Namada, with its day (UTC), the
 * moment a chart marks, its plain words, the pages it concerns and the sources a reader can open.
 */
export interface Incident {
  id: string;
  /** the UTC day the row is dated (YYYY-MM-DD) and, for a span, its last day */
  date: string;
  end?: string;
  /** unix ms of the moment a chart marks */
  at: number;
  title: string;
  text: string;
  /** route paths of the pages the row concerns */
  pages: string[];
  sources: IncidentSource[];
  /** the chart label, ${INCIDENT_MARK_MAX} characters or fewer; a row without one is listed, not drawn */
  mark?: string;
  halts?: IncidentHalt[];
  /** still running */
  ongoing?: boolean;
}

export const INCIDENTS: Incident[] = ${lit(checkIncidents(incidents))};
`;
}

/** The split from docs/data, checked (buildSupplySplit). */
export function readSupplySplit(root = ROOT): SupplySplit {
  const file = JSON.parse(readFileSync(join(root, 'docs', 'data', 'supply_since_genesis.json'), 'utf8')) as SupplyPeriodsFile;
  const rows = parseSupplyTsv(readFileSync(join(root, 'docs', 'data', 'supply_by_epoch_1207_2737.tsv'), 'utf8'));
  return buildSupplySplit(file, rows);
}

export function exportProof(root = ROOT): { proof: Proof; files: string[] } {
  const md = readFileSync(join(root, 'docs', 'replay-report.md'), 'utf8');
  const ev = JSON.parse(readFileSync(join(root, 'docs', 'events.json'), 'utf8')) as EventsFile;
  const proof = buildProof(parseReport(md), ev);
  const split = readSupplySplit(root);
  const out = join(root, 'web', 'src', 'generated');
  mkdirSync(out, { recursive: true });
  const files = [join(out, 'proof.ts'), join(out, 'events.ts'), join(out, 'supply.ts')];
  writeFileSync(files[0], renderProofTs(proof));
  writeFileSync(files[1], renderEventsTs(buildMarkers(ev), ev.generatedAt, shippedIncidents(INCIDENTS)));
  writeFileSync(files[2], renderSupplyTs(split));
  return { proof, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { proof, files } = exportProof();
  console.log(`report of ${proof.reportDate}: ${proof.priceMovesFlagged}/${proof.priceMovesTested} price moves flagged, ${proof.marketEventsTested} market events`);
  for (const f of files) console.log(`wrote ${f.slice(ROOT.length + 1)}`);
}
