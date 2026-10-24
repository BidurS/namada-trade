// Daily digest: each figure says what it is made of. The window's dollar sum names how each trade was priced (its own
// USDC price, the pool's hourly close of the outage repair, the minute's Osmosis quote); the price's changes name a base
// read another way than the reading now (kv price.how); governance's count is the page of proposals read, not the
// chain's count; the operator's checks line names an idle check so its count adds up. No fetch, no real wallet.
import { describe, expect, it } from 'vitest';
import { testD1, insert } from './d1-sqlite';
import { fixtureAddress, T } from './digest-survey';
import { SQL } from '../worker/src/digest/sql';
import { readAndBuildDigest } from '../worker/src/digest/build';
import { shapeChecks, type OperatorReads } from '../worker/src/digest/operator';
import { digestWindow } from '../worker/src/digest/figures';
import { answered } from '../worker/src/digest/types';
import { buildDigest, operatorEmbed, type Embed } from '../worker/src/digest/message';
import { figures, operator } from './fixtures/digest-2026-10-23';
import { seedCharts, seedSurvey } from './digest-survey';

const H = 3_600_000, MIN = 60_000;
const field = (e: Embed, name: string): string => {
  const f = e.fields?.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f.value;
};
const sources = (e: Embed): string[] => (e.fields ?? []).filter((f) => f.name.startsWith('Sources')).flatMap((f) => f.value.split(' · '));
const value = <V>(f: { value: V } | { notRead: true }): V => { if ('notRead' in f) throw new Error('not read'); return f.value; };

describe('the dollar sum of the window names its price bases', () => {
  const trade = (i: number, over: Record<string, unknown>) => ({
    id: `osmosis:PB${i}:swap`, chain: 'osmosis', height: i, ts: T - (i + 1) * H, tx_hash: `PB${i}`, kind: 'sell', from_addr: fixtureAddress('osmosis', i, 'qbasis'), to_addr: null,
    amount_num: 1_000, counter_denom: null, counter_amount: null, pool_id: '3005', price_usd: 0.0009, value_usd: 0.9, ...over,
  });

  it('counts each priced trade by how its price was set, as priceHowOf sets it', async () => {
    const db = testD1();
    insert(db, 'flows', [
      // a USDC trade priced at its own USDC per NAM (no priceSource): execution
      trade(1, { counter_denom: 'USDC', counter_amount: 0.9, meta: JSON.stringify({ trader: 'x' }) }),
      // the outage repair's pool close, and two at the minute's quote
      trade(2, { meta: JSON.stringify({ priceSource: 'pool_1h', priceAt: T - 3 * H }) }),
      trade(3, { meta: JSON.stringify({ priceSource: 'spot' }) }),
      trade(4, { meta: JSON.stringify({ priceSource: 'spot' }) }),
      // a price whose basis the row does not say, and an unpriced trade
      trade(5, { meta: '{}' }),
      trade(6, { price_usd: null, value_usd: null, meta: '{}' }),
    ]);
    const r = await db.prepare(SQL.trades).bind(T - 24 * H, T).first<Record<string, number>>();
    expect(r).toMatchObject({ n: 6, unpriced: 1, how_execution: 1, how_pool_1h: 1, how_spot: 2, how_swap_1h: 0, how_unstated: 1 });
  });

  it('says "at execution" only when every priced trade carries its own price', () => {
    const fig = figures();
    value(fig.trades).window.basis = { execution: 15, pool_1h: 29, spot: 79, swap_1h: 0, unstated: 0 };
    value(fig.trades).window.n = 123;
    expect(field(buildDigest(fig, T, 'daily').shared, 'Trades'))
      .toContain('$53.91 at the stored prices (15 at execution, 29 at the pool close of their hour, 79 at the Osmosis quote of their minute), 4 traders ⁸.');
    value(fig.trades).window.basis = { execution: 123, pool_1h: 0, spot: 0, swap_1h: 0, unstated: 0 };
    expect(field(buildDigest(fig, T, 'daily').shared, 'Trades')).toContain('$53.91 at execution, 4 traders ⁸.');
    // an answer that did not carry the bases says so rather than naming one
    value(fig.trades).window.basis = null;
    expect(field(buildDigest(fig, T, 'daily').shared, 'Trades')).toContain('$53.91 at the stored prices (their bases not read), 4 traders ⁸.');
  });
});

describe('the price changes name a base read another way', () => {
  const route = (since: number) => ({ how: 'route' as const, refNam: 1_000, routes: [[{ id: '3005', liquidityUsd: 40 }, { id: '3497', liquidityUsd: 900_000 }]], liquidityUsd: 40, since });

  it('the route since 06:00 UTC: both bases were read from the price list, and the source says so', async () => {
    const db = testD1();
    seedSurvey(db);
    seedCharts(db);
    insert(db, 'kv', [{ key: 'price.how', value: JSON.stringify({ log: [route(T - 2 * H)] }), updated_at: T - 2 * H }]);
    const b = await readAndBuildDigest(db, T, 'daily');
    const six = sources(b.parts.body.shared).find((x) => x.startsWith('⁶'))!;
    expect(six).toMatch(/^⁶ Osmosis SQS route spot, 1,000 NAM \(stored\) 07:59 UTC; the 24 h and 7 d bases read as Osmosis SQS \(stored\)/);
  });

  it('the route since before both bases: no base is named apart', async () => {
    const db = testD1();
    seedSurvey(db);
    seedCharts(db);
    insert(db, 'kv', [{ key: 'price.how', value: JSON.stringify({ log: [route(T - 9 * 24 * H)] }), updated_at: T - 9 * 24 * H }]);
    const b = await readAndBuildDigest(db, T, 'daily');
    const six = sources(b.parts.body.shared).find((x) => x.startsWith('⁶'))!;
    expect(six).toMatch(/^⁶ Osmosis SQS route spot, 1,000 NAM \(stored\) 07:59 UTC/);
    expect(six).not.toContain('bases read as');
    expect(six).not.toContain('base read as');
  });
});

describe('governance counts the page it read', () => {
  it('names the newest of the proposals read, never the page length as the chain count', () => {
    const v = field(buildDigest(figures(), T, 'daily').shared, 'Governance');
    expect(v).toContain('Newest of the 20 proposals read: #42 (rejected) ¹⁶.');
    expect(v).not.toContain('proposals on record');
  });
});

describe('the operator checks line', () => {
  const reads = (rows: { key: string; status: string; checked_at: number }[]): OperatorReads => ({
    healthLog: answered([]), health: answered([]), checks: answered(rows), claims: answered([]), kv: answered([]), digestClaims: answered([]), digestKeysAsked: [],
  });

  it('names an idle check, so ten ok of eleven adds up', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => ({ key: `check_${i}`, status: 'ok', checked_at: T - 5 * MIN })),
      { key: 'price_vs_execution', status: 'idle', checked_at: T - 5 * MIN },
    ];
    const shaped = shapeChecks(reads(rows), digestWindow(T, 'daily'));
    expect(value(shaped)).toMatchObject({ ok: 10, total: 11, notPassing: [], idle: ['price_vs_execution'] });
    const ops = operator();
    ops.checks = { value: { ok: 10, total: 11, failing: [], idle: ['price_vs_execution'] } };
    const text = (operatorEmbed(ops, T).fields ?? []).map((f) => f.value).join('\n') + (operatorEmbed(ops, T).description ?? '');
    expect(text).toContain('Checks: 10 of 11 ok, 1 idle (price_vs_execution: nothing to compare when last run).');
  });
});
