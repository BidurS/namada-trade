// W4: the dated proof block and the chart markers are parsed from the current replay report and events.json,
// cross-checked between them, checked in up to date, and never contain the owner's own trades.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseReport, buildProof, buildMarkers, renderProofTs, renderEventsTs, readSupplySplit, renderSupplyTs } from '../scripts/export-proof';
import { INCIDENTS } from '../scripts/incidents';

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
    // the report regenerated on 2026-10-30 carries the sixth rule's size (a shielded exit sent over the bridge)
    expect(r.thresholds).toEqual({ ibcInventory: 25000, unlock: 100000, bigSwap: 10000, unshield: 50000, bond: 1000000, exitBridge: 100000, liquidity: 100000 });
    if (r.leadRangeH) expect(r.leadRangeH[0]).toBeLessThanOrEqual(r.medianLeadH!);
  });

  it('builds the proof from figures both files agree on', async () => {
    const r = parseReport(await readReport());
    const ev = events();
    const p = buildProof(r, ev);
    expect(p.marketEventsTested).toBe(ev.events.filter((e: any) => e.type !== 'trade').length);
    expect(p.priceMovesTested).toBe(ev.events.filter((e: any) => e.type === 'price_move').length);
    expect(p.reportDate).toBe(r.generated.slice(0, 10));
    const w = p.rewindExample!;
    // the 331M of 31 Aug 2026 was the staking-account exploit and is no market event (owner decision 37): the example
    // is the largest withdrawal from staking an alert came before, 5,250,000 NAM on 19 Sep 2026 22:33 UTC, first alert 26.7 h before
    expect(w.kind).toBe('withdraw');
    expect(w.amountNam).toBe(5250000);
    expect(w.eventId).not.toBe('whale_namada:6C1989767A6939F9A');
    expect(new Date(w.firstAlertAt).toISOString().slice(0, 16)).toBe('2026-09-18T19:54');
    expect(w.rewindAt).toBe(w.firstAlertAt + 1);
    expect(w.firstAlertAt).toBeLessThan(w.at);
    expect(w.leadHours).toBeCloseTo((w.at - w.firstAlertAt) / 3600000, 1);
  });

  it('refuses a report that disagrees with events.json', async () => {
    const md = (await readReport()).replace(/withdraw 5,250,000/, 'withdraw 5,200,000');
    expect(() => buildProof(parseReport(md), events())).toThrow(/move amount/);
    // and one that files the move under another kind
    const md2 = (await readReport()).replace(/withdraw 5,250,000/, 'pos_balance 5,250,000');
    expect(() => buildProof(parseReport(md2), events())).toThrow(/move amount/);
    expect(() => parseReport('# nothing here')).toThrow(/Generated/);
  });

  it('never exports the owner\'s own trades (owner decision 10)', async () => {
    const ev = events();
    const proofTs = renderProofTs(buildProof(parseReport(await readReport()), ev));
    const eventsTs = renderEventsTs(buildMarkers(ev), ev.generatedAt, INCIDENTS);
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
    expect(renderEventsTs(buildMarkers(ev), ev.generatedAt, INCIDENTS)).toBe(readFileSync(join(ROOT, 'web', 'src', 'generated', 'events.ts'), 'utf8'));
    // the NAM-supply split since genesis, from docs/data (the periods checked against the per-epoch table)
    expect(renderSupplyTs(readSupplySplit(ROOT))).toBe(readFileSync(join(ROOT, 'web', 'src', 'generated', 'supply.ts'), 'utf8'));
  });
});
