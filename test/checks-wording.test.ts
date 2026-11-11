import { describe, expect, it } from 'vitest';
import { checkDetail, checkUi, CHECK_TITLES } from '../web/src/lib/prov';
import { checkOf, CHECK_STALE_MS } from '../worker/src/api';
import { priceVsExecution, PRICE_CHECK_WINDOW_MS, mintRuleNext, listingSumCheck, balanceGate, stakeSplit, type MintReading } from '../worker/src/cron';
import { parseBalanceListing, type MintKeys } from '../worker/src/sources/namada';
import { BANNED } from './banned-words';
import { readFileSync } from 'node:fs';
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
  it('the NAM not staked is split into unstaking and the rest by the last bond listing, at its block, and nothing is called slashed', () => {
    const now = Date.UTC(2026, 10, 2, 20, 0);
    const split = stakeSplit(343_820_912.48, 269_401_168.82, { at: now - 600_000, completeAt: now - 600_000, height: 8_516_000, epoch: 2738, provider: 'A', sources: 0, stakers: 0, totalNam: 269_402_168.82, bytes: 0, unbondingNam: 36_653_965.82, written: 0, zeroed: 0, remaining: 0, ticks: 1, durationMs: 0 }, now);
    const line = checkDetail(c('stake_within_staking_account', { notStakedNam: 343_820_912.48 - 269_401_168.82, ...split }));
    expect(line).toBe("74,419,744 NAM in the staking account is not staked: 36,653,966 unstaking or ready to withdraw (the chain's bond listing at block 8,516,000), 1,000 in bonds still waiting to start, and 37,764,778 neither staked nor unstaking, which the bond listing does not name (unclaimed rewards are held here)");
    expect(line).not.toMatch(/slash|mostly/i);
    // with no bonds waiting the part is left out
    expect(checkDetail(c('stake_within_staking_account', { notStakedNam: 74_419_743.66, unstakingNam: 36_653_965.82, waitingNam: 0, restNam: 37_765_777.84, listingHeight: 8_516_000 }))).toBe("74,419,744 NAM in the staking account is not staked: 36,653,966 unstaking or ready to withdraw (the chain's bond listing at block 8,516,000), and 37,765,778 neither staked nor unstaking, which the bond listing does not name (unclaimed rewards are held here)");
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

// The mint rule and the balance listing's sum (2026-11-02): the lines are built from the details the worker writes.
describe('the supply checks of 2026-11-02, in words', () => {
  const T = Date.UTC(2026, 10, 2, 14, 0);
  const MIN = 60_000;
  const m0 = 1_148_734_527_288_587n, inflation = 19_961_144_868n;
  const r = (epoch: number, minted: bigint, height: number, at: number): MintReading => ({ epoch, mintedBase: String(minted), height, provider: '5ElementsNodes', at, maspBase: null, posBase: null });
  const k = (over: Partial<MintKeys> = {}): MintKeys => ({ lastInflationBase: inflation, pgfRate: '0', stewardRate: '0', maspEpochMultiplier: 4, height: 0, provider: '5ElementsNodes', ...over });
  const mint = (m: { status: string; detail: Record<string, unknown> }) => checkDetail(c('supply_mint_rule', m.detail, m.status as Check['status']));
  const first = mintRuleNext(null, r(2737, m0, 8_514_100, T), null, T);
  const step = mintRuleNext(first.state, r(2738, m0 + inflation, 8_514_219, T + MIN), k(), T + MIN);
  const same = mintRuleNext(step.state, r(2738, m0 + inflation, 8_516_991, T + 2 * MIN), null, T + 2 * MIN);

  it('titles in plain words for both new checks', () => {
    expect(CHECK_TITLES.supply_mint_rule).toBe("All NAM minted changes only as an epoch starts, and only by what that epoch's inflation adds");
    expect(CHECK_TITLES.balances_sum_to_minted).toBe('The NAM balances add up to all NAM minted');
    for (const key of ['supply_mint_rule', 'balances_sum_to_minted']) expect(CHECK_TITLES[key]).not.toMatch(BANNED);
  });

  it('the mint rule says what it compared: the chain\'s own record of the staking inflation, to the base unit', () => {
    expect(mint(first)).toBe('First reading at block 8,514,100; the next minute is judged against it');
    expect(mint(step)).toBe('Grew by 19,961.144868 NAM as epoch 2738 started (read at block 8,514,219): exactly the staking inflation the chain recorded');
    expect(mint(same)).toBe('Unchanged within epoch 2738 (block 8,516,991); as the epoch started it grew by 19,961.144868 NAM, exactly the staking inflation the chain recorded');
  });

  it('the rest of a step on a shielded-reward epoch is named apart, as what it is: within the pool\'s own rise', () => {
    const a = mintRuleNext(null, { ...r(2739, m0, 100, T), maspBase: '31593419403039' }, null, T);
    const b = mintRuleNext(a.state, { ...r(2740, m0 + inflation + 250n, 108, T + MIN), maspBase: '31593419403539' }, k(), T + MIN);
    expect(mint(b)).toBe("Grew by 19,961.145118 NAM as epoch 2740 started (read at block 108): 19,961.144868 NAM of staking inflation the chain recorded and 0.000250 NAM more, within the shielded pool's own rise, where shielded rewards are credited");
    // more than the pool's own change can account for: not judged exactly, with what was compared
    const off = mintRuleNext(a.state, { ...r(2740, m0 + inflation + 250n, 108, T + MIN), maspBase: '31593419402939' }, k(), T + MIN);
    expect(mint(off)).toBe("Not judged exactly as epoch 2740 started: all NAM minted grew by 19,961.145118 NAM, 0.000250 NAM more than the staking inflation the chain recorded, while the shielded pool's NAM, where shielded rewards are credited, changed by −0.000100 NAM between blocks 100 and 108");
    const unread = mintRuleNext(a.state, r(2740, m0 + inflation + 250n, 108, T + MIN), k(), T + MIN);
    expect(mint(unread)).toBe("Not judged exactly as epoch 2740 started: all NAM minted grew by 19,961.145118 NAM, 0.000250 NAM more than the staking inflation the chain recorded, while the shielded pool's NAM, where shielded rewards are credited, was not read at both blocks (100 and 108)");
    // the next minutes say it after their own line, for a day
    const next = mintRuleNext(off.state, r(2740, m0 + inflation + 250n, 116, T + 2 * MIN), null, T + 2 * MIN);
    expect(mint(next)).toBe("Unchanged within epoch 2740 (block 116); on 2 Nov 2026, 14:01\u00a0UTC, not judged exactly as epoch 2740 started: all NAM minted grew by 19,961.145118 NAM, 0.000250 NAM more than the staking inflation the chain recorded, while the shielded pool's NAM, where shielded rewards are credited, changed by −0.000100 NAM between blocks 100 and 108");
    for (const l of [mint(off), mint(unread), mint(next)]) expect(l, l ?? '').not.toMatch(BANNED);
  });

  it('a broken rule is said first, with both blocks and the node, for a day, never as more than what was compared', () => {
    const p = mintRuleNext(same.state, r(2738, m0 + inflation + 5n, 8_517_000, T + 3 * MIN), null, T + 3 * MIN);
    expect(mint(p)).toBe('The reading at block 8,517,000 does not fit the one before; the next minute decides');
    const broke = mintRuleNext(p.state, r(2738, m0 + inflation + 5n, 8_517_008, T + 4 * MIN), null, T + 4 * MIN);
    const line = 'On 2 Nov 2026, 14:04\u00a0UTC the answers of node 5ElementsNodes for all NAM minted changed by 0.000005 NAM within epoch 2738 (blocks 8,516,991 to 8,517,008), though all NAM minted changes only as an epoch starts; read again every minute';
    expect(mint(broke)).toBe(line);
    expect(mint(mintRuleNext(broke.state, r(2738, m0 + inflation + 5n, 8_517_016, T + 5 * MIN), null, T + 5 * MIN))).toBe(line);
    expect(checkUi('warn').word).toBe('Needs a look');
    // a step by another amount names the one the chain recorded
    const s1 = mintRuleNext(same.state, r(2739, m0 + 2n * inflation + 3n, 8_517_100, T + 6 * 3600_000), k(), T + 6 * 3600_000);
    const s2 = mintRuleNext(s1.state, r(2739, m0 + 2n * inflation + 3n, 8_517_108, T + 6 * 3600_000 + MIN), k(), T + 6 * 3600_000 + MIN);
    expect(mint(s2)).toBe('On 2 Nov 2026, 20:01\u00a0UTC the answers of node 5ElementsNodes for all NAM minted grew by 19,961.144871 NAM as epoch 2739 started (blocks 8,516,991 to 8,517,108), not the 19,961.144868 NAM of staking inflation the chain recorded; read again every minute');
    // readings from two nodes: both are named
    const q1 = mintRuleNext(same.state, { ...r(2738, m0 + inflation + 5n, 8_517_000, T + 3 * MIN), provider: 'Papadritta' }, null, T + 3 * MIN);
    const q2 = mintRuleNext(q1.state, { ...r(2738, m0 + inflation + 5n, 8_517_008, T + 4 * MIN), provider: 'Papadritta' }, null, T + 4 * MIN);
    expect(mint(q2)).toBe('On 2 Nov 2026, 14:04\u00a0UTC the answers of nodes 5ElementsNodes and Papadritta for all NAM minted changed by 0.000005 NAM within epoch 2738 (blocks 8,516,991 to 8,517,008), though all NAM minted changes only as an epoch starts; read again every minute');
  });

  it('what it could not judge is said as not judged, never as a pass', () => {
    expect(mint(mintRuleNext(same.state, { why: 'minted-not-read', note: 'x' }, null, T + 3 * MIN))).toBe('Not judged this minute: the total of all NAM was not read; last judged 2 Nov 2026, 14:02\u00a0UTC');
    expect(mint(mintRuleNext(same.state, { why: 'different-blocks', note: 'x' }, null, T + 3 * MIN))).toBe('Not judged this minute: the total and the epoch came from different blocks; last judged 2 Nov 2026, 14:02\u00a0UTC');
    // (heights below block 8,517,986: a pair across it is not judged for another reason, test/halts.test.ts)
    const gap = mintRuleNext(same.state, r(2740, m0, 8_517_900, T + 13 * 3600_000), null, T + 13 * 3600_000);
    expect(mint(gap)).toBe('Not judged across 2 epochs: no reading between blocks 8,516,991 and 8,517,900');
    expect(mint(mintRuleNext(same.state, r(2739, m0, 8_517_100, T + 6 * 3600_000), k({ pgfRate: '0.01' }), T + 6 * 3600_000))).toBe('Not judged exactly as epoch 2739 started: public funding mints NAM too, on a base this check does not compute');
    // the span is said after the next minutes' lines while it is held, never dropped for an 'ok' line
    const after = mintRuleNext(gap.state, r(2740, m0, 8_517_908, T + 13 * 3600_000 + MIN), null, T + 13 * 3600_000 + MIN);
    expect(after.status).toBe('warn');
    expect(mint(after)).toBe('Unchanged within epoch 2740 (block 8,517,908); on 3 Nov 2026, 03:00\u00a0UTC, not judged across 2 epochs: no reading between blocks 8,516,991 and 8,517,900');
  });

  const BAL = JSON.parse(readFileSync(new URL('./fixtures/balance_listing.json', import.meta.url), 'utf8'));
  const sum = (over: Record<string, unknown> = {}, ctx = {}) => {
    const listing = { ...parseBalanceListing(BAL.value), height: 8_516_000, provider: 'Papadritta', ...over };
    const s = listingSumCheck(listing, balanceGate(listing, ctx), ctx, T);
    return checkDetail(c('balances_sum_to_minted', JSON.parse(String(s.params[3])), s.params[1] as Check['status']));
  };
  it('the balance listing\'s sum: exact, or the difference with its block and node; never "doesn\'t add up"', () => {
    expect(sum()).toBe('27 balances add up to 502,268,169.036412 NAM, exactly all NAM minted (block 8,516,000)');
    expect(sum({ minted: String(BigInt(BAL.expected.minted) + 12n) })).toBe('The balances differ from all NAM minted (502,268,169.036424 NAM) by 0.000012 NAM at block 8,516,000 (node Papadritta); read again next hour');
    expect(sum({ minted: null })).toBe('Not added up: the last answer (block 8,516,000) could not be used');
    const s = listingSumCheck(null, null, {}, T, 'timeout');
    expect(checkDetail(c('balances_sum_to_minted', JSON.parse(String(s.params[3])), 'idle'))).toBe('Not added up: the balances could not be read at the last try');
  });

  it('no line of either check carries a word the site does not show', () => {
    const lines = [mint(first), mint(step), mint(same), sum(), sum({ minted: '1' }), mint(mintRuleNext(same.state, { why: 'step-not-read', note: 'RPC error: x' }, null, T + 3 * MIN))];
    for (const l of lines) expect(l, l ?? '').not.toMatch(BANNED);
  });
});
