// A tick with no head the answers agree on reads no listing. The wait after it is the shortest one each time, so the
// first tick with an agreed head again is at most five minutes away, however long the nodes had no head to agree on.
// It is not a failed read: the count of failed reads in a row is left as the reads made it, so a read that fails
// before and after such a tick still backs off.
import { describe, it, expect } from 'vitest';
import { BOND_LISTING_MS, LISTING_RETRY_MS, listingDue, listingRetryMs, recordListingFailure } from '../worker/src/cron';
import { NO_AGREED_HEAD } from '../worker/src/sources/namada';
import { testD1, insert, type TestD1 } from './d1-sqlite';

const NOW = Date.UTC(2026, 5, 20, 12, 0);
const MIN = 60_000;
const NO_HEAD = `Not applied: ${NO_AGREED_HEAD} (a node: no answer; a node 100; indexer: no answer)`;
const READ_FAILED = 'Not applied: the tick failed first (x)';
const rec = (db: TestD1, key: string): any => JSON.parse((db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any).value);
const stored = (over: object) => ({ at: NOW - 5 * BOND_LISTING_MS, completeAt: NOW - 5 * BOND_LISTING_MS, height: 100, provider: 'a node', sources: 9, stakers: 9, remaining: 0, ...over });
const seed = (key: string, over: object) => { const db = testD1(); insert(db, 'kv', [{ key, value: JSON.stringify(stored(over)), updated_at: 1 }]); return db; };

describe('the wait after a tick with no agreed head', () => {
  it('is the shortest wait each time, and a count that such ticks raised before they were marked is put back, once', async () => {
    // as stored by many ticks with no head, each counted as a failure: the next try was an hour away
    const db = seed('bond.listing', { failedAt: NOW - 61 * MIN, error: NO_HEAD, failures: 40 });
    expect(listingRetryMs(40)).toBe(60 * MIN);

    await recordListingFailure(db as any, 'bond.listing', NOW, NO_HEAD, false);
    const r = rec(db, 'bond.listing');
    expect(r).toMatchObject({ failedAt: NOW, error: NO_HEAD, failures: 0, noHead: true, completeAt: NOW - 5 * BOND_LISTING_MS, height: 100, sources: 9 });
    expect(listingDue(r, BOND_LISTING_MS, NOW + LISTING_RETRY_MS - MIN)).toBe(false);
    expect(listingDue(r, BOND_LISTING_MS, NOW + LISTING_RETRY_MS)).toBe(true);

    // and so on for every such tick after it: the wait never grows
    for (let i = 1; i <= 6; i++) await recordListingFailure(db as any, 'bond.listing', NOW + i * LISTING_RETRY_MS, NO_HEAD, false);
    const later = rec(db, 'bond.listing');
    expect(later).toMatchObject({ failures: 0, noHead: true });
    expect(listingDue(later, BOND_LISTING_MS, later.failedAt + LISTING_RETRY_MS - MIN)).toBe(false);
    expect(listingDue(later, BOND_LISTING_MS, later.failedAt + LISTING_RETRY_MS)).toBe(true);
  });

  it('the reads\' own back-off goes on across such a tick: a failed read before and after it counts in a row', async () => {
    const db = seed('balance.listing', {});
    const key = 'balance.listing';
    await recordListingFailure(db as any, key, NOW, READ_FAILED);
    await recordListingFailure(db as any, key, NOW + 5 * MIN, READ_FAILED);
    expect(rec(db, key)).toMatchObject({ failures: 2, noHead: false });
    // two failed reads: fifteen minutes
    expect(listingDue(rec(db, key), BOND_LISTING_MS, NOW + 19 * MIN)).toBe(false);
    expect(listingDue(rec(db, key), BOND_LISTING_MS, NOW + 20 * MIN)).toBe(true);

    // a tick with no head: five minutes, and the two failed reads are still counted
    await recordListingFailure(db as any, key, NOW + 20 * MIN, NO_HEAD, false);
    expect(rec(db, key)).toMatchObject({ failures: 2, noHead: true, error: NO_HEAD });
    expect(listingDue(rec(db, key), BOND_LISTING_MS, NOW + 24 * MIN)).toBe(false);
    expect(listingDue(rec(db, key), BOND_LISTING_MS, NOW + 25 * MIN)).toBe(true);

    // the next read fails: the third in a row, an hour
    await recordListingFailure(db as any, key, NOW + 25 * MIN, READ_FAILED);
    const r = rec(db, key);
    expect(r).toMatchObject({ failures: 3, noHead: false });
    expect(listingDue(r, BOND_LISTING_MS, r.failedAt + 59 * MIN)).toBe(false);
    expect(listingDue(r, BOND_LISTING_MS, r.failedAt + 60 * MIN)).toBe(true);
  });

  it('a count the reads raised, stored before such ticks were marked, is not put back by one', async () => {
    const db = seed('bond.listing', { failedAt: NOW - 16 * MIN, error: READ_FAILED, failures: 2 });
    await recordListingFailure(db as any, 'bond.listing', NOW, NO_HEAD, false);
    expect(rec(db, 'bond.listing')).toMatchObject({ failures: 2, noHead: true });
    // nor is a marked record's count: the put-back happens once, for a record that never carried the mark
    await recordListingFailure(db as any, 'bond.listing', NOW + 5 * MIN, NO_HEAD, false);
    expect(rec(db, 'bond.listing')).toMatchObject({ failures: 2, noHead: true });
  });
});
