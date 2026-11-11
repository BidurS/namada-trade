// A tick with no head the answers agree on reads no listing: it is not one more failed read in a row. The wait
// after it is the shortest one each time, so the first tick with an agreed head again is at most five minutes away,
// however long the chain's nodes had no head to agree on. A read that was started and failed still backs off.
import { describe, it, expect } from 'vitest';
import { BOND_LISTING_MS, LISTING_RETRY_MS, listingDue, listingRetryMs, recordListingFailure } from '../worker/src/cron';
import { testD1, insert, type TestD1 } from './d1-sqlite';

const NOW = Date.UTC(2026, 5, 20, 12, 0);
const MIN = 60_000;
const NO_HEAD = 'Not applied: no two answers agree on the head (a node: no answer; a node 100; indexer: no answer)';
const rec = (db: TestD1, key: string): any => JSON.parse((db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any).value);
const stored = (over: object) => ({ at: NOW - 5 * BOND_LISTING_MS, completeAt: NOW - 5 * BOND_LISTING_MS, height: 100, provider: 'a node', sources: 9, stakers: 9, remaining: 0, ...over });

describe('the wait after a tick with no agreed head', () => {
  it('is the shortest wait, and a count raised by earlier such ticks is put back', async () => {
    const db = testD1();
    // as stored by many ticks with no head, each counted as a failure: the next try was an hour away
    insert(db, 'kv', [{ key: 'bond.listing', value: JSON.stringify(stored({ failedAt: NOW - 61 * MIN, error: NO_HEAD, failures: 40 })), updated_at: 1 }]);
    expect(listingRetryMs(40)).toBe(60 * MIN);

    await recordListingFailure(db as any, 'bond.listing', NOW, NO_HEAD, false);
    const r = rec(db, 'bond.listing');
    expect(r).toMatchObject({ failedAt: NOW, error: NO_HEAD, failures: 0, completeAt: NOW - 5 * BOND_LISTING_MS, height: 100, sources: 9 });
    expect(listingDue(r, BOND_LISTING_MS, NOW + LISTING_RETRY_MS - MIN)).toBe(false);
    expect(listingDue(r, BOND_LISTING_MS, NOW + LISTING_RETRY_MS)).toBe(true);

    // and so on for every such tick after it: the wait never grows
    for (let i = 1; i <= 6; i++) await recordListingFailure(db as any, 'bond.listing', NOW + i * LISTING_RETRY_MS, NO_HEAD, false);
    const later = rec(db, 'bond.listing');
    expect(later.failures).toBe(0);
    expect(listingDue(later, BOND_LISTING_MS, later.failedAt + LISTING_RETRY_MS)).toBe(true);
  });

  it('a read that was started and failed still counts in a row, from one, after a tick with no head', async () => {
    const db = testD1();
    insert(db, 'kv', [{ key: 'balance.listing', value: JSON.stringify(stored({})), updated_at: 1 }]);
    await recordListingFailure(db as any, 'balance.listing', NOW, NO_HEAD, false);
    await recordListingFailure(db as any, 'balance.listing', NOW + 5 * MIN, 'Not applied: the tick failed first (x)');
    expect(rec(db, 'balance.listing').failures).toBe(1);
    await recordListingFailure(db as any, 'balance.listing', NOW + 10 * MIN, 'Not applied: the tick failed first (x)');
    await recordListingFailure(db as any, 'balance.listing', NOW + 25 * MIN, 'Not applied: the tick failed first (x)');
    const r = rec(db, 'balance.listing');
    expect(r.failures).toBe(3);
    expect(listingDue(r, BOND_LISTING_MS, r.failedAt + 59 * MIN)).toBe(false);
    expect(listingDue(r, BOND_LISTING_MS, r.failedAt + 60 * MIN)).toBe(true);
  });
});
