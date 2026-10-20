import { describe, expect, it } from 'vitest';
import { checkDetail, checkUi } from '../web/src/lib/prov';
import { checkOf, CHECK_STALE_MS } from '../worker/src/api';
import type { Check } from '../shared/types';

// Owner feedback 2026-10-19: two "Needs a look" checks and their wording made people doubt the site.
const c = (key: string, detail: Record<string, unknown>, status: Check['status'] = 'ok'): Check => ({ key, status, title: '', detail, checkedAt: 0 });

describe('cross-check wording', () => {
  it('the bridge check names the stuck Noble transfer it counts', () => {
    expect(checkDetail(c('ibc_conservation', { driftNam: 0, stuckNam: 1614 }))).toBe('Equal, counting 1,614 NAM stuck in a transfer to Noble that was refused and never refunded (26 Jun 2026)');
  });
  it('the staking check says what it traced and what is still being read', () => {
    expect(checkDetail(c('bonded_coverage', { coveragePct: '99.6%', stakers: 21443, pendingAddresses: 120 }))).toBe('99.6% of staked NAM traced to 21,443 addresses; 120 more addresses are still being read');
  });
  it('NAM in the staking account that is not staked is not called "leaving staking"', () => {
    expect(checkDetail(c('stake_within_staking_account', { notStakedNam: 74946181 }))).toContain('not staked: unstaking, ready to withdraw, or unclaimed rewards');
  });
  it('a check that stopped running is "No recent result", never "Passes"', () => {
    expect(checkUi('stale')).toEqual({ status: 'none', word: 'No recent result' });
    const now = 1_800_000_000_000;
    expect(checkOf({ key: 'k', status: 'ok', title: 't', detail: '{}', checked_at: now - CHECK_STALE_MS - 1 }, now).status).toBe('stale');
    expect(checkOf({ key: 'k', status: 'ok', title: 't', detail: '{}', checked_at: now - 60_000 }, now).status).toBe('ok');
  });
});
