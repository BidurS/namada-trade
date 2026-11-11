// The live scan's health row (cron.ts liveScanRow) from the scan's notes (kv namada.scan) and the newest block it read
// (kv namada.scanned). A note under which the scan waits for a head (no node at it) is answered by the first block
// scanned after it, so the row is ok from that block on and not a day later. A note about nodes that disagreed
// while the scan read on, or about a block the scan could not read, stands for its day whatever was scanned since.
// The kind each note is stored with is pinned where the scan writes them (test/live-scan-head.test.ts).
import { describe, it, expect } from 'vitest';
import { liveScanRow, SCAN_NOTE_STANDS_MS } from '../worker/src/cron';
import { NO_NODE_AT_HEAD } from '../worker/src/sources/namada';

const NOW = Date.UTC(2026, 5, 20, 12, 0);
const MIN = 60_000;
const NAME = 'Namada RPC (live block scan)';
const head = (at: number, height = 101) => ({ height, at, note: `${NO_NODE_AT_HEAD} (a node: no answer)`, kind: 'head' as const });
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

  it('nodes that disagreed on the head while the scan read on: a block scanned after the note does not answer it', () => {
    const d = { height: 101, at: NOW - 4 * MIN, note: 'the Namada nodes disagree on the head (a node 200, a node 101): the scan follows the lowest', kind: 'disagree' as const };
    expect(liveScanRow({ failures: [d] }, scanned(NOW - MIN), NOW)).toEqual({ name: NAME, ok: false, at: d.at, failedAt: d.at, note: d.note });
    // and it is the row when a later note about a head the scan waited under has been answered
    expect(liveScanRow({ failures: [d, head(NOW - 3 * MIN)] }, scanned(NOW - MIN), NOW)).toMatchObject({ ok: false, failedAt: d.at });
  });

  it('a note stored before notes had a kind: the no-node note is one the scan waited under, any other stands', () => {
    const waited = { height: 101, at: NOW - 4 * MIN, note: `${NO_NODE_AT_HEAD} (a node: no answer; a node: newest block not from the last 5 minutes)` };
    expect(liveScanRow({ failures: [waited] }, scanned(NOW - 2 * MIN, 107), NOW)).toMatchObject({ ok: true, note: 'block 107 scanned after the last note about the chain\'s head (11:56 UTC)' });
    expect(liveScanRow({ failures: [waited] }, scanned(NOW - 30 * MIN), NOW)).toMatchObject({ ok: false, failedAt: waited.at });
    const other = { height: 101, at: NOW - 4 * MIN, note: 'a note with no kind' };
    expect(liveScanRow({ failures: [other] }, scanned(NOW - 2 * MIN), NOW)).toMatchObject({ ok: false, failedAt: other.at, note: 'a note with no kind' });
  });
});
