// The pools as the Trade page shows them once each pool's size is its coins at their own prices (worker/src/pool-sizes.ts):
// both reserves stand beside each size in coin units, a pool that cannot be priced reads "—" with its reason and counts in
// no total, the summed line says how many of its pools are not priced, and the head's pool depth says how many pools are
// left out and what the pools hold. Rendered to static markup; nothing reaches the network.
import { describe, it, expect, beforeAll } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Overview, PairRow, PoolInfo, Provenance } from '../shared/types';
import { depthOf, reservesOf, splitPools, pairName } from '../web/src/screens/trade/model';
import { counterName, restOf } from '../shared/pool-sides';
import { notPricedWords, NO_NAM_PRICE } from '../worker/src/pool-sizes';

let PairsList: ComponentType<any>;
let Head: ComponentType<any>;
beforeAll(async () => {
  const g = globalThis as any;
  const noop = () => {};
  g.location ??= new URL('https://namada.trade/trade');
  g.history ??= { pushState: noop, replaceState: noop, state: null };
  g.window ??= g;
  g.addEventListener ??= noop;
  g.removeEventListener ??= noop;
  g.matchMedia ??= () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
  g.localStorage ??= { getItem: () => null, setItem: noop, removeItem: noop };
  ({ PairsList } = await import('../web/src/ui/PairsList'));
  ({ Head } = await import('../web/src/screens/trade/Head'));
});
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const T = Date.UTC(2026, 9, 29, 20, 18);
const live = (note?: string): Provenance => ({ source: 'Osmosis pool reserves (pool list)', at: T, status: 'live', ...(note ? { note } : {}) });
const notPriced: Provenance = { source: 'Osmosis pool reserves (pool list)', at: T, status: 'missing', note: notPricedWords(NO_NAM_PRICE) };
const pool = (id: string, sym: string, nam: number, counter: number | null, usd: number | null, counterUsd: number | null = null): PoolInfo => ({
  id, type: 'concentrated', address: '', pair: `NAM / ${sym}`, counterDenom: sym === 'USDC' ? 'ibc/498A' : 'uosmo', counterSymbol: sym, namReserve: nam, counterReserve: counter,
  liquidityUsd: usd, counterUsd, sizeProv: usd == null ? notPriced : live(), spreadFactor: 0.002,
});
const pair = (p: PoolInfo): PairRow => ({
  poolId: p.id, pair: `NAM/${p.counterSymbol}`, counterSymbol: p.counterSymbol, type: p.type, liquidityUsd: p.liquidityUsd, namReserve: p.namReserve, counterReserve: p.counterReserve,
  spreadFactor: p.spreadFactor, sizeProv: p.sizeProv, osmosis: { value: null, prov: { source: 'Osmosis data API', at: null, status: 'missing', note: 'Not recorded yet.' } },
  here24h: { value: null, prov: { source: 'D1 flow index', at: null, status: 'missing', note: 'Not recorded yet.' } }, createdAt: null,
});

describe('the pools list: sizes from the reserves, both reserves beside them', () => {
  const pools = [
    pool('3005', 'USDC', 982_189.503942, 158.59, 1_016.89, 158.59),
    pool('3368', 'OSMO', 100_000, 1_000, 140.9, 52.9),
    pool('3402', 'OSMO', 50_000, 20, null),
    pool('3008', 'USDC', 910_154.558525, 0, 819.14, 0),
    pool('3999', 'OSMO', 10, 1, 0.06, 0.05),
  ];

  it('a one-sided pool keeps its own row and its size counts; a pool not priced that holds NAM gets a row; the small rest is summed', () => {
    const { shown, rest, oneSided, total } = splitPools(pools);
    expect(oneSided.map((p) => p.id)).toEqual(['3008']);
    expect(shown.map((p) => p.id)).toEqual(['3005', '3368', '3402']);
    expect(rest.map((p) => p.id)).toEqual(['3999']);
    expect(total).toBeCloseTo(1_016.89 + 140.9 + 819.14 + 0.06, 9);
    expect(restOf([pools[2], pools[4]])).toEqual({ usd: 0.06, max: 0.06, notPriced: 1 });
    expect(counterName({ pair: 'NAM / ibc/0FA9232B262B89E77D1335D5', counterSymbol: 'ibc/0FA9232B262B89E77D1335D5' })).toBe('coin 0FA923…');
    expect(pairName({ pair: 'NAM / factory/osmo1x/alloyed/allBTC', counterSymbol: 'factory/osmo1x/alloyed/allBTC' })).toBe('NAM / allBTC');
  });

  it('each row: its size, the NAM and the other coin inside; a pool not priced reads "—" with its reason; the summed line counts the pools not priced', () => {
    const rows = pools.map(pair);
    const html = text(renderToStaticMarkup(createElement(PairsList, {
      pairs: [rows[0], rows[1], rows[2]], oneSided: [rows[3]], rest: [rows[4], { ...rows[2], poolId: '4000' }], totalUsd: 1_976.99, pairName: (p: PairRow) => p.pair, label: 'Pools that trade NAM',
    })));
    expect(html).toContain('Depth');
    expect(html).toContain('Inside');
    expect(html).toContain('$1,017');
    expect(html).toContain('982,190 NAM');
    expect(html).toContain('158.59 USDC');
    expect(html).toContain('1,000.00 OSMO');
    // the pool that cannot be priced: no figure, the reason in view
    expect(html).toContain(`— ${notPricedWords(NO_NAM_PRICE)}`);
    // the one-sided pool: its NAM's worth, its 0 USDC, the line that says what it holds
    expect(html).toContain('$819');
    expect(html).toContain('0.00 USDC');
    expect(html).toContain('no USDC inside: it can be bought from, not sold into');
    expect(html).toContain('2 more pools');
    expect(html).toContain('1 of them not priced, so not counted');
  });

  it('the head\'s pool depth: the priced pools\' sum, how many are left out, and the coins inside', () => {
    const d = depthOf({ pools, prov: { source: 'Osmosis pool reserves', at: T, status: 'live' } }, null)!;
    expect(d).toMatchObject({ count: 5, notPriced: 1, fromList: true });
    expect(d.usd).toBeCloseTo(1_016.89 + 140.9 + 819.14 + 0.06, 9);
    expect(reservesOf(pools)).toEqual({ nam: 982_189.503942 + 100_000 + 50_000 + 910_154.558525 + 10, coins: [{ name: 'USDC', amount: 158.59, usd: 158.59 }, { name: 'OSMO', amount: 1_021, usd: null }] });
    const html = text(renderToStaticMarkup(createElement(Head, {
      overview: null, overviewFailed: false, depth: d, rewound: false,
      changes: { data: null, error: null, loading: true, fetchedAt: null, failedAt: null, unserved: false, retry: () => {} },
      volume: { data: null, error: null, loading: true, fetchedAt: null, failedAt: null, unserved: false, retry: () => {} },
    })));
    expect(html).toContain('$1,977');
    expect(html).toContain('in 5 pools, 1 of them not priced and left out');
    expect(html).toContain('holding 2,042,354 NAM , 158.59 USDC and 1,021.00 OSMO');
    // nothing priced: no figure, and the first pool's reason says why
    const none = depthOf({ pools: [pool('3005', 'USDC', 1, 1, null)], prov: { source: 'Osmosis pool reserves', at: T, status: 'live' } }, null)!;
    expect(none.usd).toBeNull();
    expect(none.stamp).toMatchObject({ status: 'missing', note: notPricedWords(NO_NAM_PRICE) });
    // the overview's stored reading has no reserves and no count of pools left out
    expect(depthOf(null, { dex: { liquidityUsd: 1_000, pools: 9, prov: { source: 'Osmosis pool reserves', at: T, status: 'live' } } } as unknown as Overview)).toMatchObject({ usd: 1_000, count: 9, notPriced: null, reserves: null });
  });
});
