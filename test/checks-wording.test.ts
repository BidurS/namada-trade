import { describe, expect, it } from 'vitest';
import { checkDetail, checkUi } from '../web/src/lib/prov';
import { checkOf, CHECK_STALE_MS } from '../worker/src/api';
import { priceVsExecution, PRICE_CHECK_WINDOW_MS } from '../worker/src/cron';
import type { Check } from '../shared/types';

// Owner feedback 2026-10-19: two "Needs a look" checks and their wording made people doubt the site.
const c = (key: string, detail: Record<string, unknown>, status: Check['status'] = 'ok'): Check => ({ key, status, title: '', detail, checkedAt: 0 });

describe('cross-check wording', () => {
  it('the bridge check names the stuck Noble transfer it counts', () => {
    const noble = { nam: 1614, sentAt: '2026-06-26T11:13:59Z', note: 'stuck in a transfer to Noble that was refused and never refunded' };
    expect(checkDetail(c('ibc_conservation', { driftNam: 0, stuckNam: 1614, stuckPackets: [noble] }))).toBe('Equal, counting 1,614 NAM stuck in a transfer to Noble that was refused and never refunded (26 Jun 2026)');
    expect(checkDetail(c('ibc_conservation', { driftNam: 250.4, stuckNam: 1614, stuckPackets: [noble] }))).toBe('250.4 NAM apart, counting 1,614 NAM stuck in a transfer to Noble that was refused and never refunded (26 Jun 2026)');
    // the list is verified against the indexer each tick: once the packet is refunded there is nothing to count
    expect(checkDetail(c('ibc_conservation', { driftNam: 0, stuckNam: 0, stuckPackets: [] }))).toBe('Equal');
    expect(checkDetail(c('ibc_conservation', { driftNam: 1614 }))).toBe('1,614 NAM apart');
    expect(checkDetail(c('ibc_conservation', { driftNam: 0, stuckNam: 1700, stuckPackets: [{ sentAt: '2026-10-01T00:00:00Z' }, noble] }))).toBe('Equal, counting 1,700 NAM stuck in 2 transfers never delivered and never refunded (since 26 Jun 2026)');
  });
  it('the staking check says what it traced and what is still being read', () => {
    expect(checkDetail(c('bonded_coverage', { coveragePct: '99.6%', stakers: 21443, pendingAddresses: 120 }))).toBe('99.6% of staked NAM traced to 21,443 addresses; 120 more addresses are still being read');
    // the chain's bond listing counts bonds still waiting to start, so it can exceed the total stake a little
    expect(checkDetail(c('bonded_coverage', { coveragePct: '100.3%', stakers: 19454, pendingAddresses: 0 }))).toBe('All staked NAM traced to 19,454 addresses; their bonds add up to 100.3% of the total stake because bonds still waiting to start are listed too');
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

  // Owner report 2026-10-20: the price check read "No recent result" for hours although every source answered; the
  // market simply had no direct NAM-to-USDC trade in the last 6 h.
  describe('the price check with no trade to compare', () => {
    const now = 1_792_501_200_000; // 2026-10-20 13:00 UTC
    const H = 3_600_000;
    it('compares the quote with the last hour of trades while that hour is inside the window', () => {
      const r = priceVsExecution(0.001155, { ts: now - 5 * H, value: 0.001177 }, null, now);
      expect(r?.status).toBe('ok');
      expect(checkDetail(c('price_vs_execution', r!.detail))).toBe('1.87% apart');
    });
    it('past the window it still runs and says it had nothing to compare, naming the last trade', () => {
      const lastTrade = Date.UTC(2026, 9, 20, 7, 6);
      const r = priceVsExecution(0.001155, { ts: now - PRICE_CHECK_WINDOW_MS - 1, value: 0.001177 }, lastTrade, now);
      expect(r?.status).toBe('idle');
      expect(r?.detail).toMatchObject({ noTrades: true, lastTradeAt: lastTrade, windowHours: 6 });
      expect(checkUi('idle')).toEqual({ status: 'none', word: 'Nothing to compare' });
      expect(checkDetail(c('price_vs_execution', r!.detail, 'idle'))).toBe('Last direct NAM-to-USDC trade: 20 Oct 2026, 07:06\u00a0UTC');
    });
    it('with no trade ever recorded it says so, and never invents a time', () => {
      const r = priceVsExecution(0.001155, null, null, now);
      expect(r?.status).toBe('idle');
      expect(checkDetail(c('price_vs_execution', r!.detail, 'idle'))).toBe('No direct NAM-to-USDC trade on record');
    });
    it('without a quote nothing is written, so the check goes quiet and reads "No recent result"', () => {
      expect(priceVsExecution(null, { ts: now - H, value: 0.001177 }, null, now)).toBeNull();
      expect(priceVsExecution(0, { ts: now - H, value: 0.001177 }, null, now)).toBeNull();
    });
    it('"Nothing to compare" is served while fresh and turns "No recent result" when the check stops running', () => {
      const row = { key: 'price_vs_execution', status: 'idle', title: 't', detail: '{"noTrades":true}' };
      expect(checkOf({ ...row, checked_at: now - 60_000 }, now).status).toBe('idle');
      expect(checkOf({ ...row, checked_at: now - CHECK_STALE_MS - 1 }, now).status).toBe('stale');
    });
  });
});
