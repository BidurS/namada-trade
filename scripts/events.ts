/**
 * Phase 1: build the event replay set from D1.
 *
 *   node --experimental-strip-types scripts/events.ts
 *
 * Writes docs/events.json (the test set the replay harness and the alert backtest run against)
 * and docs/events.md (the human-readable version).
 *
 * Two kinds of events:
 *   price_move  – the largest hour-to-hour moves in the swap-derived price (price.swap_1h), where the
 *                 gap between the two price points is at most 48h.
 *   whale_flow  – the largest single on-chain flows, with the price change over the following 24h/72h.
 * For each event we record every flow in the 48h before it that any alert rule could have seen.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { d1, iso } from './lib.ts';

const H = 3600000;
const LEAD = 48 * H;
const INTERNAL = new Set([
  'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp', // PoS
  'tnam1qcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvtr7x4', // IBC escrow
  'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah', // MASP
  'tnam1pgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqkhgajr', // PGF
]);

type Price = { ts: number; value: number };
type Flow = { id: string; chain: string; ts: number; kind: string; from_addr: string | null; to_addr: string | null; amount_num: number; value_usd: number | null; meta: string | null; from_label: string | null; to_label: string | null };

const prices = d1<Price>(`SELECT ts, value FROM metrics WHERE key='price.swap_1h' ORDER BY ts`);
const priceAt = (ts: number): Price | null => {
  let best: Price | null = null;
  for (const p of prices) if (p.ts <= ts && (!best || p.ts > best.ts)) best = p;
  return best;
};
const priceAfter = (ts: number): Price | null => {
  for (const p of prices) if (p.ts >= ts) return p;
  return null;
};

function leadFlows(t: number): Flow[] {
  return d1<Flow>(`
    SELECT f.id, f.chain, f.ts, f.kind, f.from_addr, f.to_addr, f.amount_num, f.value_usd, f.meta, l1.label from_label, l2.label to_label
    FROM flows f LEFT JOIN labels l1 ON l1.address=f.from_addr LEFT JOIN labels l2 ON l2.address=f.to_addr
    WHERE f.ts >= ${t - LEAD} AND f.ts < ${t} AND f.kind != 'rewards' AND f.kind != 'other'
      AND f.amount_num >= 5000
    ORDER BY f.amount_num DESC LIMIT 40`);
}

// 1. price moves
const moves: { t0: number; t1: number; p0: number; p1: number; pct: number }[] = [];
for (let i = 1; i < prices.length; i++) {
  const a = prices[i - 1], b = prices[i];
  if (b.ts - a.ts > LEAD) continue;
  moves.push({ t0: a.ts, t1: b.ts, p0: a.value, p1: b.value, pct: (b.value / a.value - 1) * 100 });
}
moves.sort((x, y) => Math.abs(y.pct) - Math.abs(x.pct));

// 2. whale flows (largest real moves of NAM, excluding reward payouts and arb churn)
const whales = d1<Flow & { from_label: string | null; to_label: string | null }>(`
  SELECT f.id, f.chain, f.ts, f.kind, f.from_addr, f.to_addr, f.amount_num, f.value_usd, f.meta, l1.label from_label, l2.label to_label
  FROM flows f LEFT JOIN labels l1 ON l1.address=f.from_addr LEFT JOIN labels l2 ON l2.address=f.to_addr
  WHERE f.kind NOT IN ('rewards','other') AND f.ts >= ${prices[0]?.ts ?? 0}
  ORDER BY f.amount_num DESC LIMIT 12`);

const events: any[] = [];
for (const m of moves.slice(0, 10)) {
  const lead = leadFlows(m.t1);
  events.push({
    id: `price_${new Date(m.t1).toISOString().slice(0, 13)}`,
    type: 'price_move',
    t0: m.t0, t1: m.t1, priceBefore: m.p0, priceAfter: m.p1, pct: +m.pct.toFixed(1),
    leadSignals: lead.map(sig),
  });
}
for (const w of whales) {
  const before = priceAt(w.ts), after24 = priceAfter(w.ts + 24 * H), after72 = priceAfter(w.ts + 72 * H);
  const lead = leadFlows(w.ts).filter((f) => f.id !== w.id);
  events.push({
    id: `whale_${w.id.slice(0, 24)}`,
    type: 'whale_flow',
    t0: w.ts - LEAD, t1: w.ts,
    flow: sig(w),
    priceBefore: before?.value ?? null,
    pct24h: before && after24 ? +((after24.value / before.value - 1) * 100).toFixed(1) : null,
    pct72h: before && after72 ? +((after72.value / before.value - 1) * 100).toFixed(1) : null,
    leadSignals: lead.map(sig),
  });
}

// 3. the owner's own trades (private/trades.json, git-ignored), scored like market events but written only to
//    private/ (owner decision 10: they never enter docs/ or the public repository)
const trades: any[] = existsSync('private/trades.json') ? JSON.parse(readFileSync('private/trades.json', 'utf8')) : [];
const tradeEvents: any[] = [];
for (const t of trades) {
  const before = priceAt(t.ts), after24 = priceAfter(t.ts + 24 * H), after72 = priceAfter(t.ts + 72 * H);
  tradeEvents.push({
    id: t.id, type: 'trade', t0: t.ts - LEAD, t1: t.ts,
    trade: { address: t.address, action: t.action, amountNam: t.amountNam, note: t.note },
    priceBefore: before?.value ?? null,
    pct24h: before && after24 ? +((after24.value / before.value - 1) * 100).toFixed(1) : null,
    pct72h: before && after72 ? +((after72.value / before.value - 1) * 100).toFixed(1) : null,
    leadSignals: leadFlows(t.ts).map(sig),
  });
}

function sig(f: Flow) {
  const meta = f.meta ? JSON.parse(f.meta) : {};
  return {
    id: f.id, chain: f.chain, ts: f.ts, kind: f.kind, amountNam: Math.round(f.amount_num),
    valueUsd: f.value_usd == null ? null : +f.value_usd.toFixed(2),
    from: f.from_addr, fromLabel: f.from_label, to: f.to_addr, toLabel: f.to_label,
    internal: INTERNAL.has(f.from_addr ?? '') || INTERNAL.has(f.to_addr ?? ''),
    arb: !!meta.arb, tsSource: meta.tsSource ?? 'block',
  };
}

// Base rate: how often is at least one alert-size flow present in the 48h before *any* price point?
// If this is near 100%, "flagged ahead of the move" means little; the replay report shows both numbers.
const MIN_ALERT_NAM = 10000;
const alertFlows = d1<{ ts: number }>(`SELECT ts FROM flows WHERE amount_num >= ${MIN_ALERT_NAM} AND kind IN ('ibc_in','withdraw','buy','sell','unshield','bond')
  AND (meta IS NULL OR meta NOT LIKE '%"arb":true%') AND ts >= ${prices[0].ts - LEAD} ORDER BY ts`).map((r) => r.ts);
let armed = 0;
for (const p of prices) if (alertFlows.some((t) => t >= p.ts - LEAD && t < p.ts)) armed++;
const baseRate = prices.length ? armed / prices.length : null;

writeFileSync('docs/events.json', JSON.stringify({ generatedAt: Date.now(), pricePoints: prices.length, baseRate, minAlertNam: MIN_ALERT_NAM, events }, null, 1));

const short = (a: string | null, l: string | null) => (l ? l.slice(0, 28) : a ? `${a.slice(0, 10)}…${a.slice(-4)}` : '—');
let md = `# Event replay set (Phase 1)\n\nGenerated ${iso(Date.now())} UTC from D1. Price = hourly median of executed single-pool NAM/USDC swaps (${prices.length} points, ${iso(prices[0].ts)} → ${iso(prices[prices.length - 1].ts)}); hours with no swap have no point, so a "move" can span several hours.\n\n`;
md += `## Largest price moves\n\n| # | window (UTC) | move | lead signals ≥5k NAM in prior 48h |\n|---|---|---|---|\n`;
events.filter((e) => e.type === 'price_move').forEach((e, i) => {
  const s = e.leadSignals.filter((x: any) => !x.arb).slice(0, 4).map((x: any) => `${x.kind} ${x.amountNam.toLocaleString()} ${short(x.from, x.fromLabel)}→${short(x.to, x.toLabel)}`).join('; ');
  md += `| ${i + 1} | ${iso(e.t0)} → ${iso(e.t1)} | ${e.pct > 0 ? '+' : ''}${e.pct}% | ${s || '_none_'} |\n`;
});
md += `\n## Largest single flows and what price did next\n\n| flow (UTC) | kind | NAM | from → to | 24h | 72h |\n|---|---|---|---|---|---|\n`;
events.filter((e) => e.type === 'whale_flow').forEach((e) => {
  const f = e.flow;
  md += `| ${iso(f.ts)} | ${f.kind} | ${f.amountNam.toLocaleString()} | ${short(f.from, f.fromLabel)} → ${short(f.to, f.toLabel)} | ${e.pct24h == null ? '—' : (e.pct24h > 0 ? '+' : '') + e.pct24h + '%'} | ${e.pct72h == null ? '—' : (e.pct72h > 0 ? '+' : '') + e.pct72h + '%'} |\n`;
});
if (tradeEvents.length) {
  let pm = `## The owner's own trades (private)\n\n| trade | action | NAM | 24h after | 72h after | note |\n|---|---|---|---|---|---|\n`;
  tradeEvents.forEach((e) => {
    pm += `| ${iso(e.t1)} | ${e.trade.action} | ${e.trade.amountNam.toLocaleString()} | ${e.pct24h == null ? '—' : (e.pct24h > 0 ? '+' : '') + e.pct24h + '%'} | ${e.pct72h == null ? '—' : (e.pct72h > 0 ? '+' : '') + e.pct72h + '%'} | ${e.trade.note} |\n`;
  });
  writeFileSync('private/events-trades.md', pm);
  writeFileSync('private/events-trades.json', JSON.stringify({ generatedAt: new Date().toISOString(), events: tradeEvents }, null, 1));
}
md += `\n**Base rate:** a flow ≥ ${MIN_ALERT_NAM.toLocaleString()} NAM (non-arb) occurred in the 48h before ${baseRate == null ? '—' : (baseRate * 100).toFixed(0) + '%'} of all ${prices.length} price points. Any "flagged" rate must be read against this.\n`;
md += `\nFull detail, including every lead signal with its timestamp source, is in [events.json](events.json). The replay harness (\`npm run test:replay\`) scores the alert rules against this file.\n`;
writeFileSync('docs/events.md', md);
console.log(md);
