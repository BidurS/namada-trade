// A row says what moved with its NAM (worker/src/parse/osmosis.ts alsoCoins, rewardOf; web/src/lib/settle.ts
// alsoCoinsWords, rewardWords). The wallet traced on 2026-10-29 withdrew position 15533215 of pool 3005 and took its
// spread rewards in one message (tx EFEF3604…, height 73,498,387): the site's rows carried 142,448.988745 NAM out of
// the pool and 185.868422 NAM of rewards as a plain transfer, without the 60.517489 USDC and 0.320610 USDC that came in
// the same legs, and without saying the transfer was the position's rewards. A second payout (tx 1B9137F4…) took
// 14.022644 NAM and 0.045031 USDC of position 15532678's rewards. Both transactions as an Osmosis node served them on
// 2026-10-30.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normFromTxSearch, osmoAssets, parseOsmosisTx, type OsmoCtx } from '../worker/src/parse/osmosis';
import { alsoCoinsWords, rewardWords } from '../web/src/lib/settle';

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const P3005 = 'osmo1m459jtgn77tz8cffvthq5jh0erswxu9872mjd9qde546mslc6udq85we5r';
const ctx: OsmoCtx = { poolAddrs: new Map([[P3005, '3005']]), priceUsd: null, assets: osmoAssets() };
const parse = (name: string) => parseOsmosisTx(normFromTxSearch(fx(name), 1), ctx).flows;

describe('the coins that moved with a row’s NAM', () => {
  it('a withdrawal carries the pool’s USDC beside its NAM, and its rewards are a transfer that says whose rewards they are', () => {
    const rows = parse('osmo_withdraw_position_rewards.json');
    const lp = rows.find((f) => f.kind === 'lp_remove')!;
    expect(lp).toMatchObject({ amount: 142448.988745, poolId: '3005' });
    expect(lp.meta).toMatchObject({ alsoCoins: { USDC: 60.517489 } });
    expect(alsoCoinsWords(lp)).toBe('60.52 USDC'); // the house coin format (fmtCoinAmount): two places from one unit up
    expect(rewardWords(lp)).toBe(null);
    const reward = rows.find((f) => f.kind === 'transfer')!;
    expect(reward).toMatchObject({ amount: 185.868422 });
    expect(reward.meta).toMatchObject({ alsoCoins: { USDC: 0.32061 }, reward: 'spread', rewardPool: '3005', rewardPosition: '15533215' });
    expect(alsoCoinsWords(reward)).toBe('0.321 USDC'); // under one unit, three significant figures (fmtCoinAmount), never 0.00
    expect(rewardWords(reward)).toBe('Spread rewards of position 15533215 in pool 3005');
  });

  it('a payout of rewards alone is tagged the same way, and a coin the asset map does not know is kept by its denom in base units', () => {
    const [reward] = parse('osmo_collect_spread_rewards.json').filter((f) => f.kind === 'transfer');
    expect(reward).toMatchObject({ amount: 14.022644 });
    expect(reward.meta).toMatchObject({ alsoCoins: { USDC: 0.045031 }, reward: 'spread', rewardPool: '3005', rewardPosition: '15532678' });
    const bare = parseOsmosisTx(normFromTxSearch(fx('osmo_collect_spread_rewards.json'), 1), { ...ctx, assets: new Map() }).flows.find((f) => f.kind === 'transfer')!;
    expect(bare.meta).toMatchObject({ alsoCoinsUnknown: { 'ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4': '45031' } });
    expect(bare.meta?.alsoCoins).toBeUndefined();
    expect(alsoCoinsWords(bare)).toBe('45,031 base units of ibc/498A0751C798A0D9…');
  });

  it('a row whose legs carried NAM alone has no other coins and no reward tag', () => {
    expect(alsoCoinsWords({ meta: null })).toBe(null);
    expect(alsoCoinsWords({ meta: { priceSource: 'spot' } })).toBe(null);
    expect(rewardWords({ meta: { priceSource: 'spot' } })).toBe(null);
  });
});
