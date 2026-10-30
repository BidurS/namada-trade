/**
 * Replay harness (Phase 4). For every event in docs/events.json, run the alert rules over the flows
 * that preceded it and record whether any rule fired and how far ahead of the move it fired.
 * Writes docs/replay-report.md. Run with `npm run test:replay`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateFlows, DEFAULT_THRESHOLDS } from '../shared/alerts';
import type { Flow } from '../shared/types';

const file = join(__dirname, '..', 'docs', 'events.json');
const data = JSON.parse(readFileSync(file, 'utf8')) as { events: any[]; pricePoints: number; baseRate?: number | null; minAlertNam?: number };

const toFlow = (s: any): Flow => ({
  id: s.id, chain: s.chain, height: 0, ts: s.ts, txHash: s.id.split(':')[1] ?? '', kind: s.kind,
  from: s.from, to: s.to, amount: s.amountNam, fromLabel: s.fromLabel, toLabel: s.toLabel,
  meta: { arb: s.arb, tsSource: s.tsSource },
});

const H = 3600000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

describe('alert rules vs. historical events', () => {
  const rows: { id: string; type: string; move: string; hits: number; firstHit: number | null; leadH: number | null; rules: string[]; exactTs: boolean }[] = [];

  for (const ev of data.events) {
    const flows = ev.leadSignals.map(toFlow) as Flow[];
    const hits = evaluateFlows(flows, DEFAULT_THRESHOLDS).filter((h) => h.ts < ev.t1);
    const first = hits.length ? Math.min(...hits.map((h) => h.ts)) : null;
    rows.push({
      id: ev.id, type: ev.type,
      move: ev.type === 'price_move' ? `${ev.pct > 0 ? '+' : ''}${ev.pct}%` : ev.type === 'trade' ? `${ev.trade.action} ${ev.trade.amountNam.toLocaleString()} (own) → 24h ${ev.pct24h == null ? '—' : (ev.pct24h > 0 ? '+' : '') + ev.pct24h + '%'}` : `${ev.flow.kind} ${ev.flow.amountNam.toLocaleString()} → 24h ${ev.pct24h == null ? '—' : (ev.pct24h > 0 ? '+' : '') + ev.pct24h + '%'}`,
      hits: hits.length, firstHit: first, leadH: first == null ? null : (ev.t1 - first) / H,
      rules: [...new Set(hits.map((h) => h.ruleId))],
      exactTs: hits.every((h) => (flows.find((f) => f.id === h.flowId)?.meta?.tsSource ?? 'block') === 'block'),
    });
  }

  it('writes the report', () => {
    const priceMoves = rows.filter((r) => r.type === 'price_move');
    const flagged = priceMoves.filter((r) => r.hits > 0);
    const leads = flagged.map((r) => r.leadH!).sort((a, b) => a - b);
    const median = leads.length ? leads[leads.length >> 1] : null;

    let md = `# Replay report\n\nGenerated ${iso(Date.now())} UTC by \`test/replay.test.ts\` from \`docs/events.json\` (${data.events.length} events, ${data.pricePoints} price points) with default thresholds ${JSON.stringify(DEFAULT_THRESHOLDS)}.\n\n`;
    md += `**Price moves flagged ahead of time: ${flagged.length} / ${priceMoves.length}.** Median lead ${median == null ? '—' : median.toFixed(1) + ' h'}; range ${leads.length ? `${leads[0].toFixed(1)}–${leads[leads.length - 1].toFixed(1)} h` : '—'}.\n\n`;
    md += `A "flag" means at least one alert rule fired on a flow in the 48h before the move completed. It does not mean the rule predicted the direction: the table shows what fired so you can judge that yourself.\n\n`;
    if (data.baseRate != null) md += `**Base rate:** ${(data.baseRate * 100).toFixed(0)}% of all price points had an alert-size flow (≥ ${(data.minAlertNam ?? 10000).toLocaleString()} NAM) in the prior 48h. Flagging ${flagged.length}/${priceMoves.length} moves is only informative to the extent it beats that; the lead-time and rule columns are the useful part.\n\n`;
    md += `| event | move | rules fired | first alert | lead | exact times |\n|---|---|---|---|---|---|\n`;
    for (const r of rows) md += `| ${r.id} | ${r.move} | ${r.rules.join(', ') || '_none_'} | ${r.firstHit ? iso(r.firstHit) : '—'} | ${r.leadH == null ? '—' : r.leadH.toFixed(1) + ' h'} | ${r.exactTs ? 'yes' : 'estimated'} |\n`;
    md += `\n## Misses\n\n`;
    const misses = priceMoves.filter((r) => r.hits === 0);
    md += misses.length ? misses.map((r) => `- ${r.id} (${r.move}): no flow ≥ threshold in the prior 48h. Either the move came from flows below threshold, from pools other than 3005, or from outside the indexed window.`).join('\n') : '_none_';
    md += `\n\n## Caveats\n\n- Prices are hourly medians of executed swaps; hours without trades have no point, so some "moves" span many hours and the lead time is an upper bound.\n- Osmosis flows older than ~2026-08-30 carry extrapolated timestamps (see the "exact times" column).\n- The arb-exclusion rule depends on \`meta.arb\`, which the Osmosis parser sets only for round-trips within one tx.\n`;
    // Written only when it says something new: a run whose report differs from the file in its "Generated" time alone
    // leaves the tracked file (and the proof block's date, scripts/export-proof.ts) as it is, so the suite keeps a
    // clean tree clean (scripts/deploy-check.sh stops when the tests change it).
    const out = join(__dirname, '..', 'docs', 'replay-report.md');
    const GENERATED = /^Generated \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/m;
    let before = '';
    try { before = readFileSync(out, 'utf8'); } catch { /* no report yet */ }
    if (before.replace(GENERATED, '') !== md.replace(GENERATED, '')) writeFileSync(out, md);
    console.log(md);
    expect(rows.length).toBe(data.events.length);
  });

  it('fires on the known whale events, and never on the staking account\'s own balance transfers', () => {
    const whale = rows.filter((r) => r.type === 'whale_flow');
    expect(whale.length).toBeGreaterThan(0);
    // The 331M of 31 Aug 2026 and the 100M "bonds" of 22 Sep were transfers of the staking account's own balance
    // (docs/design/screener-plan.md 3.0): filed as pos_balance, they trip neither "NAM unstaked" nor "Large amount staked".
    const pos = data.events.filter((e: any) => e.type === 'whale_flow' && e.flow.kind === 'pos_balance');
    expect(pos.length).toBeGreaterThan(0);
    for (const e of pos) expect(evaluateFlows([toFlow(e.flow)], DEFAULT_THRESHOLDS).filter((h) => h.ruleId === 'unlock' || h.ruleId === 'bond')).toEqual([]);
    const big = data.events.find((e: any) => e.type === 'whale_flow' && e.flow.kind === 'withdraw');
    if (big) expect(evaluateFlows([toFlow(big.flow)], DEFAULT_THRESHOLDS).some((h) => h.ruleId === 'unlock')).toBe(true);
  });
});
