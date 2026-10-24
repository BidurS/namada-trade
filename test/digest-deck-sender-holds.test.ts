// Daily digest, the attention section's NAM on deck: what the crossing's sender holds is its whole NAM, or says which
// part it is (the holder index keeps spendable and staked NAM apart; the rank is by the total).
import { describe, it, expect } from 'vitest';
import { testD1, insert } from './d1-sqlite';
import { readAttentionFigures, attentionEmbed } from '../worker/src/digest/attention';

const NOW = Date.UTC(2026, 9, 24, 5, 0);
const MIN = 60_000;
const osmo = (s: string) => `osmo1${s.padEnd(38, 'q')}`;
const tnam = (s: string) => `tnam1${s.padEnd(40, 'q')}`;

describe('the sender of a crossing on deck', () => {
  it('a staker that keeps 0.74 NAM spendable is not said to hold 0.74 NAM', async () => {
    const db = testD1();
    const sender = tnam('stkr'), receiver = osmo('rcvr');
    insert(db, 'flows', [
      { id: 'osmosis:DK1:0', chain: 'osmosis', height: 1, ts: NOW - 34 * MIN, tx_hash: 'DK1', kind: 'ibc_in', from_addr: sender, to_addr: receiver, amount_num: 979, counter_denom: null, counter_amount: null, pool_id: null, price_usd: null, value_usd: null, meta: '{}' },
      { id: 'osmosis:DK2:swap', chain: 'osmosis', height: 2, ts: NOW - 31 * MIN, tx_hash: 'DK2', kind: 'sell', from_addr: receiver, to_addr: null, amount_num: 974.11, counter_denom: 'USDC', counter_amount: 0.84, pool_id: '3005', price_usd: 0.00086, value_usd: 0.84, meta: JSON.stringify({ trader: receiver }) },
    ]);
    insert(db, 'holders', [{ chain: 'namada', address: sender, balance: '737712', balance_num: 0.737712, stake_num: 750969.149527, total_num: 750969.887239, updated_at: NOW - 34 * MIN }]);
    const fig = await readAttentionFigures(db as unknown as D1Database, NOW);
    const deck = attentionEmbed(fig, 'A0').embed.fields!.find((f) => f.name === 'NAM on deck')!.value;
    expect(deck).toContain('from `tnam1stkrq…qqqqq`');
    expect(deck).not.toMatch(/holds 0\.74 NAM;/);
  });
});
