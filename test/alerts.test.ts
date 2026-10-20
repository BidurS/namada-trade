// W9: alert rules in plain words (ids, thresholds and logic unchanged) and W5: /api/alerts/recent returns `last`.
import { describe, it, expect } from 'vitest';
import { alertRules, evaluateFlow, DEFAULT_THRESHOLDS } from '../shared/alerts';
import { lastAlertBefore } from '../worker/src/analytics';
import { app } from '../worker/src/api';
import { testD1, insert } from './d1-sqlite';
import type { AlertsRecentResponse, Flow } from '../shared/types';

const BANNED = /\b(SQS|IBC|DEX|PoS|MASP|ABCI|RPC|cron|webhook|npm|D[1-7])\b|unbond|unshield|arbitrage|≥/i;

describe('alert rules in plain words (W9)', () => {
  it('keeps ids, thresholds and decisions; titles are the brief\'s names', () => {
    const rules = alertRules();
    expect(rules.map((r) => [r.id, r.thresholdNam, r.decision])).toEqual([
      ['ibc_inventory', 25000, 'D2'], ['unlock', 100000, 'D3'], ['big_swap', 10000, 'D4'], ['unshield', 50000, 'D5'], ['bond', 1000000, 'D3'],
    ]);
    expect(rules.map((r) => r.title)).toEqual(['NAM bridged to Osmosis', 'NAM unstaked', 'Large trade', 'NAM left the shielded set', 'Large amount staked']);
    expect(rules.find((r) => r.id === 'unshield')!.condition).toBe('50,000 NAM or more moved out of the shielded set to a personal address');
    for (const r of rules) {
      expect(r.title, r.id).not.toMatch(BANNED);
      expect(r.condition, r.id).not.toMatch(BANNED);
      expect(r.condition, r.id).toContain(r.thresholdNam.toLocaleString('en-US'));
    }
    expect(alertRules({ ...DEFAULT_THRESHOLDS, bigSwap: 2500 }).find((r) => r.id === 'big_swap')!.condition).toBe('A single buy or sell of 2,500 NAM or more on Osmosis, bot trades left out');
  });

  it('hit titles and details are plain words and prefer plain labels', () => {
    const base: Flow = { id: 'x', chain: 'namada', height: 1, ts: 1, txHash: 'X', kind: 'unbond', from: 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp', to: 'tnam1qxuser00000000000000000000000000000000', amount: 1111257 };
    const hits = [
      evaluateFlow(base)[0],
      evaluateFlow({ ...base, kind: 'withdraw' })[0],
      evaluateFlow({ ...base, chain: 'osmosis', kind: 'sell', from: 'osmo1seller', priceUsd: 0.001025, amount: 20000 })[0],
      evaluateFlow({ ...base, kind: 'unshield', from: 'tnam1pcqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzmefah', amount: 60000 })[0],
      evaluateFlow({ ...base, kind: 'bond', from: 'tnam1qxuser00000000000000000000000000000000', amount: 2000000, fromLabel: 'Genesis: af_backers', fromLabelPlain: 'Early backers (genesis)' })[0],
      evaluateFlow({ ...base, chain: 'osmosis', kind: 'ibc_in', amount: 30000, toLabel: 'Namada PoS (bonded + unbonding)', toLabelPlain: 'Staking account (staked and unstaking NAM)' })[0],
    ];
    expect(hits.map((h) => h.title)).toEqual([
      '1,111,257 NAM started unstaking (spendable when the wait ends)',
      '1,111,257 NAM unlocked and withdrawn from staking',
      'Sold 20,000 NAM at $0.001025',
      '60,000 NAM moved out of the shielded set',
      '2,000,000 NAM staked',
      '30,000 NAM bridged to Osmosis',
    ]);
    expect(hits[4].detail).toBe('by Early backers (genesis)');
    expect(hits[5].detail).toMatch(/^to Staking account/);
    for (const h of hits) expect(`${h.title} ${h.detail}`).not.toMatch(BANNED);
  });
});

// ---------------------------------------------------------------- W5

const NOW = Date.UTC(2026, 9, 17, 12);
const D = 86400000;
const row = (id: string, ts: number, chain: string, kind: string, amount: number, meta: unknown = null) => ({
  id, chain, height: 1, ts, tx_hash: id.toUpperCase(), kind, from_addr: chain === 'osmosis' ? 'osmo1a' : 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp', to_addr: 'tnam1qxuser', amount_num: amount, meta: meta ? JSON.stringify(meta) : null,
});

describe('the last alert of any age (W5)', () => {
  it('returns the newest hit before the time, however old, using the same rules', async () => {
    const db = testD1();
    insert(db, 'flows', [
      row('old', NOW - 16 * D, 'namada', 'bond', 2999716),
      row('small', NOW - 2 * D, 'namada', 'bond', 999),
      row('below', NOW - 3 * D, 'osmosis', 'sell', 9999),
      row('internal', NOW - 4 * D, 'namada', 'unshield', 80000, null), // to a user: counts
    ]);
    // an unshield into a protocol account never fires
    insert(db, 'flows', [{ ...row('toPos', NOW - 1 * D, 'namada', 'unshield', 90000), to_addr: 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp' }]);
    const last = await lastAlertBefore(db as any, NOW, DEFAULT_THRESHOLDS);
    expect(last).toMatchObject({ flowId: 'internal', ruleId: 'unshield' });
    const before = await lastAlertBefore(db as any, NOW - 5 * D, DEFAULT_THRESHOLDS);
    expect(before).toMatchObject({ flowId: 'old', ruleId: 'bond', title: '2,999,716 NAM staked' });
    expect(await lastAlertBefore(db as any, NOW - 20 * D, DEFAULT_THRESHOLDS)).toBeNull();
  });

  it('pages back past candidates the rules reject', async () => {
    const db = testD1();
    insert(db, 'flows', [
      row('hit', NOW - 10 * D, 'osmosis', 'buy', 50000),
      ...Array.from({ length: 12 }, (_, i) => ({ ...row(`rej${i}`, NOW - i * 60000, 'namada', 'unshield', 90000), to_addr: 'tnam1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8j2fp' })),
    ]);
    expect(await lastAlertBefore(db as any, NOW, DEFAULT_THRESHOLDS, 5, 5)).toMatchObject({ flowId: 'hit', ruleId: 'big_swap' });
    // gave up after 2 full pages: not known (undefined), never "none on record" (null)
    expect(await lastAlertBefore(db as any, NOW, DEFAULT_THRESHOLDS, 2, 5)).toBeUndefined();
  });

  it('GET /api/alerts/recent carries `last`: the newest hit when there are hits, else the last one of any age', async () => {
    const db = testD1();
    insert(db, 'flows', [row('old', NOW - 16 * D, 'namada', 'bond', 2999716)]);
    const get = async (qs: string) => (await (await app.request(`/api/alerts/recent?${qs}`, {}, { DB: db } as any)).json()) as AlertsRecentResponse;
    const quiet = await get(`at=${NOW}`);
    expect(quiet.hits).toEqual([]);
    expect(quiet.last).toMatchObject({ flowId: 'old', ts: NOW - 16 * D, amountNam: 2999716 });
    insert(db, 'flows', [row('new', NOW - 3600000, 'osmosis', 'sell', 20000)]);
    const busy = await get(`at=${NOW}`);
    expect(busy.hits.map((h) => h.flowId)).toEqual(['new']);
    expect(busy.last).toEqual(busy.hits[0]);
    // a disabled rule (unreachable threshold) is not the "last one" either
    const off = await get(`at=${NOW}&bigSwap=${Number.MAX_SAFE_INTEGER}`);
    expect(off.hits).toEqual([]);
    expect(off.last?.flowId).toBe('old');
  });

  it('GET /api/alerts/recent omits `last` when its own search fails, so the client never reads "none on record"', async () => {
    const db = testD1();
    insert(db, 'flows', [row('old', NOW - 16 * D, 'namada', 'bond', 2999716)]);
    // the 24 h read answers; the paged search for the last hit (the only query with OFFSET) fails
    const failing = { ...db, prepare: (sql: string) => { if (/OFFSET/.test(sql)) throw new Error('D1 down'); return (db as any).prepare(sql); } };
    const r = await app.request(`/api/alerts/recent?at=${NOW}`, {}, { DB: failing } as any);
    expect(r.status).toBe(200);
    const body = (await r.json()) as AlertsRecentResponse;
    expect(body.hits).toEqual([]);
    expect('last' in body).toBe(false);
  });
});
