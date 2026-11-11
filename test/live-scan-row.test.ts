// The live scan's health row (cron.ts liveScanRow) from the scan's notes (kv namada.scan) and the newest block it read
// (kv namada.scanned). A note about the head says the scan is waiting for one: a block scanned after it supersedes
// it, so the row is ok from that block on and not a day later. A note about a block the scan could not read stands
// for its day whatever was scanned since.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { liveScanRow, SCAN_NOTE_STANDS_MS } from '../worker/src/cron';

const NOW = Date.UTC(2026, 5, 20, 12, 0);
const MIN = 60_000;
const NAME = 'Namada RPC (live block scan)';
const head = (at: number, height = 101) => ({ height, at, note: 'no Namada node is at the chain\'s head (a node: no answer)', kind: 'head' as const });
const block = (at: number, height = 90) => ({ height, at, note: `block ${height} not scanned: Error: a shape this reader does not know`, kind: 'block' as const });
const scanned = (at: number, height = 105) => ({ height, at });

describe('the live scan\'s health row', () => {
  it('with no note there is no row', () => {
    expect(liveScanRow(null, null, NOW)).toBeNull();
    expect(liveScanRow({ failures: [] }, scanned(NOW), NOW)).toBeNull();
  });

  it('a note about the head stands while no block has been scanned after it', () => {
    const note = head(NOW - 4 * MIN);
    for (const s of [null, scanned(NOW - 30 * MIN)]) {
      expect(liveScanRow({ failures: [head(NOW - 14 * MIN), note] }, s, NOW)).toEqual({ name: NAME, ok: false, at: note.at, failedAt: note.at, note: note.note });
    }
  });

  it('a block scanned after the notes about the head supersedes them: the row is ok, with the block and the time of the last such note', () => {
    const row = liveScanRow({ failures: [head(NOW - 24 * MIN), head(NOW - 14 * MIN), head(NOW - 4 * MIN)] }, scanned(NOW - 2 * MIN, 107), NOW);
    expect(row).toEqual({ name: NAME, ok: true, at: NOW - 2 * MIN, note: 'block 107 scanned after the last note about the chain\'s head (11:56 UTC)' });
    // a newer note about the head stands again until the next block
    const again = head(NOW - MIN);
    expect(liveScanRow({ failures: [head(NOW - 4 * MIN), again] }, scanned(NOW - 2 * MIN), NOW)).toMatchObject({ ok: false, failedAt: again.at });
  });

  it('a block the scan could not read stands for its day, whatever was scanned since, and is the row when it is the newest note standing', () => {
    const b = block(NOW - 3 * 60 * MIN);
    const notes = { failures: [b, head(NOW - 14 * MIN), head(NOW - 4 * MIN)] };
    expect(liveScanRow(notes, scanned(NOW - 2 * MIN), NOW)).toEqual({ name: NAME, ok: false, at: b.at, failedAt: b.at, note: b.note });
    // a day after it the row is ok and says so, as before
    const later = b.at + SCAN_NOTE_STANDS_MS;
    expect(liveScanRow(notes, scanned(NOW - 2 * MIN), later)).toEqual({ name: NAME, ok: true, at: b.at, note: 'last unreadable block 90, more than a day ago' });
    expect(liveScanRow(notes, scanned(NOW - 2 * MIN), later - 1)).toMatchObject({ ok: false });
  });

  it('a note stored before notes had a kind stands as a block does', () => {
    const old = { height: 101, at: NOW - 4 * MIN, note: 'a note with no kind' };
    expect(liveScanRow({ failures: [old] }, scanned(NOW - 2 * MIN), NOW)).toMatchObject({ ok: false, failedAt: old.at, note: 'a note with no kind' });
  });

  it('the scan stores which kind each note is: a head it cannot follow as a head, everything else as a block', () => {
    const src = readFileSync(new URL('../worker/src/live-hub.ts', import.meta.url), 'utf8');
    expect(src).toContain("private async noteScanFailure(height: number, note: string, kind: 'head' | 'block' = 'block') {");
    expect(src).toContain("await this.noteScanFailure(height, note, 'head');");
    // one call marks a head; the others take the default
    expect(src.split("'head');").length - 1).toBe(1);
  });
});
