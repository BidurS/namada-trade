// Daily digest, the attention section's "Others" line: the trades it names and the "more" it counts add up to the
// window's trades.
import { describe, it, expect } from 'vitest';
import { testD1, insert } from './d1-sqlite';
import { readAttentionFigures, attentionEmbed, type TradesFigures } from '../worker/src/digest/attention';

const NOW = Date.UTC(2026, 9, 24, 5, 0);
const H = 3_600_000;
const OSMO = (i: number) => `osmo1digest${String(i).padStart(32, 'q')}`;
const row = (id: number, ts: number, maker: string, nam: number) => ({
  id: `osmosis:T${id}:0`, chain: 'osmosis', height: 1, ts, tx_hash: `T${id}`, kind: 'buy', from_addr: null, to_addr: maker, amount_num: nam,
  counter_denom: null, counter_amount: null, pool_id: '3005', price_usd: null, value_usd: null, meta: JSON.stringify({ trader: maker }),
});

describe('the Others line of the largest trades', () => {
  it('counts every trade of the window: shown, named in a run, or in the "more"', async () => {
    const db = testD1();
    const rows = [
      row(1, NOW - 20 * H, OSMO(1), 10_000), row(2, NOW - 19 * H, OSMO(2), 9_000), row(3, NOW - 18 * H, OSMO(3), 8_000),
      // one maker's two small buys within a minute: the run the line names
      row(4, NOW - 10 * H, OSMO(4), 1_900), row(5, NOW - 10 * H + 30_000, OSMO(4), 1_800),
      // nine more trades by nine makers, hours apart
      ...[900, 800, 700, 600, 500, 400, 300, 200, 100].map((nam, i) => row(10 + i, NOW - (17 - i) * H, OSMO(10 + i), nam)),
    ];
    insert(db, 'flows', rows);
    const fig = await readAttentionFigures(db as unknown as D1Database, NOW);
    expect((fig.trades as TradesFigures).n).toBe(14);
    const largest = attentionEmbed(fig, 'A0').embed.fields!.find((f) => f.name === 'Largest trades')!.value;
    const others = largest.split('\n').find((l) => l.startsWith('Others:'))!;
    // 3 shown + 2 in the run = 5, so 9 trades are left for "more"
    expect(others).toContain('2 buys of ~1,850 NAM');
    expect(others).toMatch(/; and 9 more\.$/);
  });
});
