// The alert rule for liquidity added to or taken out of a NAM pool on Osmosis (shared/alerts.ts 'liquidity', owner
// 2026-11-01: "one option for liquidity add and remove from certain amount, as a toggle in alerts"): one transaction's
// NAM into or out of the pools' addresses (worker/src/parse/osmosis.ts lp_add, lp_remove) of the subscriber's size and
// up, its pools and its other coins named; read by the Alerts page's two queries as by the live posts.
import { describe, it, expect } from 'vitest';
import { evaluateFlow, DEFAULT_THRESHOLDS, alertRules } from '../shared/alerts';
import { alertsBetween, lastAlertBefore } from '../worker/src/analytics';
import { defaultPrefs, thresholdsOf, withEveryRule, type StoredSettings } from '../worker/src/settings';
import { testD1, insert } from './d1-sqlite';
import type { Flow } from '../shared/types';

const LP = 'osmo1testsellerqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
const T = Date.UTC(2026, 9, 27, 7, 0);
const lp = (kind: 'lp_add' | 'lp_remove', amount: number, extra: Partial<Flow> = {}): Flow => ({
  id: `osmosis:L${kind}${amount}:${kind}`, chain: 'osmosis', height: 73_498_387, ts: T, txHash: `L${kind}${amount}`, kind,
  from: kind === 'lp_add' ? LP : null, to: kind === 'lp_remove' ? LP : null, amount, poolId: '3005', priceUsd: 0.0004, valueUsd: amount * 0.0004, ...extra,
});
const off = { ...DEFAULT_THRESHOLDS, ibcInventory: 1e12, unlock: 1e12, bigSwap: 1e12, unshield: 1e12, bond: 1e12, exitBridge: 1e12 };

describe('the liquidity rule', () => {
  it('fires on an add or a removal of the size and up, names the pool and the other coin, and not under the size or on another chain', () => {
    // the seller's withdrawal of position 15533215 (tx EFEF3604…, 2026-10-27): 142,448.988745 NAM and 60.517489 USDC out of pool 3005
    const out = evaluateFlow(lp('lp_remove', 142_448.988745, { meta: { alsoCoins: { USDC: 60.517489 } } })).find((h) => h.ruleId === 'liquidity')!;
    expect(out.title).toBe('142,449 NAM taken out of pool 3005');
    expect(out.detail).toBe('by osmo1tests…qqqq, with 60.52 USDC');
    expect(out.address).toBe(LP);
    const add = evaluateFlow(lp('lp_add', 200_000, { poolId: '3005,3368' })).find((h) => h.ruleId === 'liquidity')!;
    expect(add.title).toBe('200,000 NAM added to pools 3005, 3368');
    expect(add.detail).toBe('by osmo1tests…qqqq');
    expect(evaluateFlow(lp('lp_add', 99_999)).some((h) => h.ruleId === 'liquidity')).toBe(false);
    expect(evaluateFlow({ ...lp('lp_add', 500_000), chain: 'namada' }).some((h) => h.ruleId === 'liquidity')).toBe(false);
    expect(evaluateFlow(lp('lp_add', 5_000), { ...DEFAULT_THRESHOLDS, liquidity: 5_000 }).some((h) => h.ruleId === 'liquidity')).toBe(true);
    // a rebalance (one transaction taking out and putting in, review of 2026-11-01): one alert, on the add, as a move
    const reb = { meta: { lpRebalance: true } };
    expect(evaluateFlow(lp('lp_remove', 200_000, reb)).some((h) => h.ruleId === 'liquidity')).toBe(false);
    expect(evaluateFlow(lp('lp_add', 200_000, { ...reb, poolId: '3368' })).find((h) => h.ruleId === 'liquidity')!.title).toBe('200,000 NAM of liquidity moved into pool 3368');
    // a coin the asset map does not know, or a symbol that is not one, is never shown
    expect(evaluateFlow(lp('lp_add', 200_000, { meta: { alsoCoinsUnknown: { 'ibc/ABC': '5' }, alsoCoins: { 'claim.xyz/x': 1, USDC: 0.0451 } } })).find((h) => h.ruleId === 'liquidity')!.detail).toBe('by osmo1tests…qqqq, with 0.0451 USDC');
    expect(alertRules().find((r) => r.id === 'liquidity')!.condition).toBe('100,000 NAM or more added to or taken out of a NAM pool on Osmosis in one transaction');
  });

  it('is a switch and a size of its own in the saved settings: on for a new subscriber, off for one whose settings predate it', () => {
    expect(defaultPrefs().rules.liquidity).toEqual({ on: true, thresholdNam: 100_000 });
    const p = defaultPrefs();
    delete (p.rules as Record<string, unknown>).liquidity;
    const old: StoredSettings = { address: 'tnam1qxuser00000000000000000000000000000000', notifications: p, channels: { discord: { enabled: false, webhookUrl: null } }, createdAt: 0, updatedAt: 0 };
    expect(withEveryRule(old).notifications.rules.liquidity).toEqual({ on: false, thresholdNam: 100_000 });
    expect(thresholdsOf(withEveryRule(old).notifications).liquidity).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('the Alerts page reads it, in the window and in the search for the last alert', async () => {
    const db = testD1();
    const f = lp('lp_add', 250_000);
    insert(db, 'flows', [{ id: f.id, chain: 'osmosis', height: f.height, ts: f.ts, tx_hash: f.txHash, kind: 'lp_add', from_addr: LP, to_addr: null, amount_num: 250_000, pool_id: '3005', price_usd: 0.0004, value_usd: 100, meta: '{}' }]);
    const hits = await alertsBetween(db as any, T - 3_600_000, T + 1, DEFAULT_THRESHOLDS);
    expect(hits.map((h) => [h.ruleId, h.flowId])).toEqual([['liquidity', f.id]]);
    expect(await lastAlertBefore(db as any, T + 1, off)).toMatchObject({ ruleId: 'liquidity', flowId: f.id });
    expect(await lastAlertBefore(db as any, T + 1, { ...off, liquidity: 1e12 })).toBe(null);
  });
});

describe('the other coins in words', () => {
  it('the alert rule says an amount as the site\'s coin format does (shared/format.ts fmtCoinAmount), without importing it', async () => {
    const { alsoCoinsText } = await import('../shared/alerts');
    const { fmtCoinAmount } = await import('../shared/format');
    for (const v of [60.517489, 1668.114, 1, 0.320610, 0.0451, 0.000123456]) expect(alsoCoinsText({ alsoCoins: { USDC: v } })).toBe(`${fmtCoinAmount(v)} USDC`);
  });
});
