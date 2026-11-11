// The measured epoch length leaves out an epoch in which Namada made no blocks for a time. An epoch ends at the first
// block made after the chain's minimum has passed, so one much longer than the minimum is not how long an epoch is
// while blocks are made; counted into the thirty-day mean it would stretch the unstaking wait and every date counted
// in epochs for thirty days. The note says how many were left out. The long epoch here is an arbitrary one.
import { describe, it, expect } from 'vitest';
import { EPOCH_MAX_MINIMUMS, measureEpochSec } from '../worker/src/analytics';
import { testD1, insert } from './d1-sqlite';

const M = 60_000, H = 60 * M, D = 24 * H;
const MIN_SEC = 21_600;
const NOW = Date.UTC(2026, 5, 20, 12, 0);

/** A reading a minute; each entry is one epoch's length in hours, the first epoch numbered `first`. */
function readings(hours: number[], first = 500, start = NOW - 10 * D) {
  const rows: { ts: number; key: string; value: number }[] = [];
  let t = start;
  hours.forEach((h, i) => { for (const end = t + h * H; t < end; t += M) rows.push({ ts: t, key: 'epoch', value: first + i }); });
  return rows;
}

describe('the measured epoch length', () => {
  it('leaves out an epoch longer than twice the chain\'s minimum, and says so', async () => {
    expect(EPOCH_MAX_MINIMUMS).toBe(2);
    const db = testD1();
    // the first and the last epoch are never measured (their other end is not seen); of the six between, one is long
    insert(db, 'metrics', readings([6, 6, 6, 6, 60, 6, 6, 3]));
    const m = await measureEpochSec(db as any, NOW, MIN_SEC, null);
    expect(m.sec).toBeCloseTo(6 * 3600, -1);
    expect(m.note).toBe('about 6.00 h an epoch, measured over the last 5 epochs; 1 epoch left out, in which Namada made no blocks for a time');
  });

  it('with the long epoch counted the mean would have been hours longer: that is what is kept out', async () => {
    const db = testD1();
    insert(db, 'metrics', readings([6, 6, 6, 6, 60, 6, 6, 3]));
    // a minimum of 0 is no minimum to measure against: nothing is left out, as before
    const all = await measureEpochSec(db as any, NOW, 0, null);
    expect(all.sec).toBeCloseTo(((5 * 6 + 60) / 6) * 3600, -1);
    expect(all.note).toBe('about 15.00 h an epoch, measured over the last 6 epochs');
  });

  it('an epoch a little longer than the minimum is an epoch: only one past twice the minimum is left out', async () => {
    const db = testD1();
    insert(db, 'metrics', readings([6, 6.5, 11.9, 6.5, 12.1, 6.5, 3]));
    const m = await measureEpochSec(db as any, NOW, MIN_SEC, null);
    expect(m.sec).toBeCloseTo(((6.5 * 3 + 11.9) / 4) * 3600, -1);
    expect(m.note).toMatch(/measured over the last 4 epochs; 1 epoch left out, in which Namada made no blocks for a time$/);
  });

  it('two left out are counted as two; with fewer than three epochs kept, the length is not measured from them', async () => {
    const db = testD1();
    insert(db, 'metrics', readings([6, 30, 6, 6, 6, 40, 3]));
    const two = await measureEpochSec(db as any, NOW, MIN_SEC, null);
    expect(two.note).toBe('about 6.00 h an epoch, measured over the last 3 epochs; 2 epochs left out, in which Namada made no blocks for a time');

    const few = testD1();
    insert(few, 'metrics', readings([6, 6, 60, 6, 3]));
    const m = await measureEpochSec(few as any, NOW, MIN_SEC, null);
    // two epochs kept: no mean of them, and no genesis time given here, so the chain's minimum, said as such
    expect(m.sec).toBe(MIN_SEC);
    expect(m.note).toBe('the shortest an epoch can be (6 h); epochs are often longer');
  });
});
