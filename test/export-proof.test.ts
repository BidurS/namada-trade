// W4: the dated proof block and the chart markers are parsed from the current replay report and events.json,
// cross-checked between them, checked in up to date, and never contain the owner's own trades.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReport, buildProof, buildMarkers, renderProofTs, renderEventsTs } from '../scripts/export-proof';

const ROOT = join(__dirname, '..');

/** test/replay.test.ts rewrites the report while the suite runs: read it once it is whole. */
async function readReport(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const md = readFileSync(join(ROOT, 'docs', 'replay-report.md'), 'utf8');
    if (md.includes('## Caveats')) return md;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('docs/replay-report.md is incomplete');
}
const events = () => JSON.parse(readFileSync(join(ROOT, 'docs', 'events.json'), 'utf8'));

describe('export-proof', () => {
  it('parses the current report', async () => {
    const r = parseReport(await readReport());
    expect(r.generated).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(r.events).toBe(events().events.length);
    expect(r.rows.length).toBe(r.events);
    expect(r.flagged).toBeLessThanOrEqual(r.priceMoves);
    expect(r.windowH).toBe(48);
    expect(r.thresholds).toEqual({ ibcInventory: 25000, unlock: 100000, bigSwap: 10000, unshield: 50000, bond: 1000000 });
    if (r.leadRangeH) expect(r.leadRangeH[0]).toBeLessThanOrEqual(r.medianLeadH!);
  });

  it('builds the proof from figures both files agree on', async () => {
    const r = parseReport(await readReport());
    const ev = events();
    const p = buildProof(r, ev);
    expect(p.marketEventsTested).toBe(ev.events.filter((e: any) => e.type !== 'trade').length);
    expect(p.priceMovesTested).toBe(ev.events.filter((e: any) => e.type === 'price_move').length);
    expect(p.reportDate).toBe(r.generated.slice(0, 10));
    const w = p.largestWithdrawal!;
    expect(w.amountNam).toBe(331386682);
    // the first alert is at 19:05 in the report; rewound one millisecond after it, that alert is visible
    expect(new Date(w.firstAlertAt).toISOString().slice(0, 16)).toBe('2026-08-30T19:05');
    expect(w.rewindAt).toBe(w.firstAlertAt + 1);
    expect(w.firstAlertAt).toBeLessThan(w.at);
    expect(w.leadHours).toBeCloseTo((w.at - w.firstAlertAt) / 3600000, 1);
  });

  it('refuses a report that disagrees with events.json', async () => {
    const md = (await readReport()).replace(/withdraw 331,386,682/, 'withdraw 331,000,000');
    expect(() => buildProof(parseReport(md), events())).toThrow(/withdrawal amount/);
    expect(() => parseReport('# nothing here')).toThrow(/Generated/);
  });

  it('never exports the owner\'s own trades (owner decision 10)', async () => {
    const ev = events();
    const proofTs = renderProofTs(buildProof(parseReport(await readReport()), ev));
    const eventsTs = renderEventsTs(buildMarkers(ev), ev.generatedAt);
    // The public events.json never holds the owner's trades; they live in private/ (git-ignored). When that file
    // is present (the owner's machine), nothing from it may reach the exported files either.
    expect(ev.events.filter((e: any) => e.type === 'trade')).toHaveLength(0);
    const priv = join(ROOT, 'private', 'events-trades.json');
    const own: any[] = existsSync(priv) ? JSON.parse(readFileSync(priv, 'utf8')).events : [];
    for (const out of [proofTs, eventsTs]) {
      expect(out).not.toMatch(/trade_|\(own\)/);
      for (const t of own) {
        expect(out).not.toContain(t.id);
        expect(out).not.toContain(String(t.t1));
        for (const a of [t.trade?.from, t.trade?.to, t.trade?.address, t.trade?.txHash].filter(Boolean)) expect(out).not.toContain(a);
      }
    }
  });

  it('the checked-in files are what the script writes now', async () => {
    const ev = events();
    const p = buildProof(parseReport(await readReport()), ev);
    const proofFile = readFileSync(join(ROOT, 'web', 'src', 'generated', 'proof.ts'), 'utf8');
    // the report's own timestamp changes every time the replay test runs; everything else must match
    const at = Number(/"reportGeneratedAt": (\d+)/.exec(proofFile)![1]);
    const date = /"reportDate": "([\d-]+)"/.exec(proofFile)![1];
    expect(renderProofTs({ ...p, reportGeneratedAt: at, reportDate: date })).toBe(proofFile);
    expect(renderEventsTs(buildMarkers(ev), ev.generatedAt)).toBe(readFileSync(join(ROOT, 'web', 'src', 'generated', 'events.ts'), 'utf8'));
  });
});
