// Every coin in the shielded pool (builder G, 2026-11-08; migration 0024 masp_coins_daily, worker/src/masp-coins.ts).
// Fixture: block_results of block 6,966,497 as namada-rpc.stakeandrelax.net served it on 2026-11-08 (nothing stripped;
// namada-rpc.polkachu.com's answer was byte for byte the same), one of the June 2026 shielded-pool drain blocks (Namada
// announced the drain on 20 June 2026): one transfer of 150,355.823285 Noble USDC from the pool to an address, with the
// pool's post-balance of that coin, 0, and one masp/transfer event; its time from /blockchain (block_metas 6,966,497 to
// 6,966,500, the same node). The parser keeps the post-balance, the hub merges it into kv masp.coins and names the fall
// to the operator's channel alone when the coin's value before it was at least the floor, and the daily job confirms
// each stored coin once a day with one read of the chain.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { parseNamadaBlock, NAMADA_TOKENS } from '../worker/src/parse/namada';
import { maspSeenOf } from '../worker/src/masp-seen';
import { SCANNED_KV } from '../worker/src/masp-activity';
import {
  MASP_COINS_KV, COIN_FALL_FLOOR_USD, MASP_COIN_QUOTE, coinAmountWords, coinDailyKey, coinDayFigures, coinDayStmts, coinFallWords, coinOf, coinUnits,
  fallValueUsd, isCoinFall, maspCoinsOf, mergeMaspCoins, type CoinFall, type MaspCoins,
} from '../worker/src/masp-coins';
import { blockFromResults } from '../scripts/refile-masp-fees';
import { daily } from '../worker/src/series';
import { NAMADA } from '../worker/src/config';
import { QUOTE_KEYS } from '../shared/settle';
import { BANNED } from './banned-words';
import { testD1, runStmts, type TestD1 } from './d1-sqlite';
import type { SourceHealth } from '../shared/types';

afterEach(() => { vi.unstubAllGlobals(); });

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const RESULTS = fx('namada_block_6966497.json');
const METAS = fx('namada_blockchain_6966497_6966500.json').result.block_metas as { header: { height: string; time: string } }[];
const timeOf = (h: number) => Date.parse(METAS.find((m) => Number(m.header.height) === h)!.header.time);
const H6966497 = 6_966_497;
const TS = timeOf(H6966497);
const USDC = 'tnam1pkl64du8p2d240my5umxm24qhrjsvh42ruc98f97';
const STATOM = 'tnam1p5z5538v3kdk3wdx7r2hpqm4uq9926dz3ughcp7n';
const MASP = NAMADA.internal.masp;
const all = (db: TestD1, sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p).map((r: any) => ({ ...r }));
const kvOf = (db: TestD1, key: string) => { const r = db.raw.prepare('SELECT value FROM kv WHERE key = ?').get(key); return r ? JSON.parse(r.value) : null; };
const D = 86_400_000, H = 3_600_000;

describe('the parser keeps the pool\'s post-balance of every other coin (block 6,966,497)', () => {
  const block = blockFromResults(RESULTS, H6966497, TS);
  it('the block\'s time is the chain\'s, the one transfer is the coin\'s, and the pool\'s post-balance of it is kept by token address', () => {
    expect(new Date(TS).toISOString()).toBe('2026-06-18T09:25:13.095Z');
    const p = parseNamadaBlock(block, null);
    expect(p.maspCoins).toEqual({ [USDC]: { base: '0', via: 'post-balance' } });
    expect(NAMADA_TOKENS[USDC].symbol).toBe('USDC (Noble)');
    expect(p.flows).toHaveLength(1);
    expect(p.flows[0]).toMatchObject({ kind: 'unshield', from: MASP, amount: 150_355.823285, counterDenom: 'USDC (Noble)', height: H6966497, ts: TS });
    expect(p.flows[0].meta).toMatchObject({ tokenSymbol: 'USDC (Noble)', tokenAddress: USDC, tokenDecimals: 6 });
    // NAM post-balances are the holders'; none here
    expect(p.balances).toEqual([]);
  });
  it('the block\'s one shielded transaction is recorded by its index with the block\'s time', () => {
    expect(maspSeenOf(block)).toEqual({ seen: [{ height: H6966497, blockIndex: 0, batchIndex: 0, kind: 'transfer', ts: TS }], refused: 0 });
  });
  it('an IBC mint or burn at the pool names the coin with no post-balance; a later transfer in the block gives one', () => {
    const mint = { type: 'token/mint', attributes: [{ key: 'token-event-descriptor', value: 'ibc' }, { key: 'token-address', value: STATOM }, { key: 'target-account', value: `internal-address/${MASP}` }, { key: 'amount', value: '5000000' }, { key: 'hash', value: 'AA' }] };
    expect(parseNamadaBlock({ height: 1, ts: 1, events: [mint] }, null).maspCoins).toEqual({ [STATOM]: { base: null, via: 'ibc' } });
    const transfer = { type: 'token/transfer', attributes: [
      { key: 'hash', value: 'BB' }, { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
      { key: 'source-accounts', value: JSON.stringify([[[`internal-address/${MASP}`, STATOM], '1000000']]) },
      { key: 'target-accounts', value: JSON.stringify([[['implicit-address/tnam1qr4l8egaskk09460llz0qctac7sgemynpu8c7vvd', STATOM], '1000000']]) },
      { key: 'post-balances', value: JSON.stringify([[[`internal-address/${MASP}`, STATOM], '4000000'], [['implicit-address/tnam1qr4l8egaskk09460llz0qctac7sgemynpu8c7vvd', STATOM], '1000000']]) },
    ] };
    expect(parseNamadaBlock({ height: 1, ts: 1, events: [mint, transfer] }, null).maspCoins).toEqual({ [STATOM]: { base: '4000000', via: 'post-balance' } });
    // the mint after the transfer is the last word: the post-balance no longer holds
    expect(parseNamadaBlock({ height: 1, ts: 1, events: [transfer, mint] }, null).maspCoins).toEqual({ [STATOM]: { base: null, via: 'ibc' } });
  });
});

describe('kv masp.coins: the merge and the fall rule', () => {
  const NOW = Date.UTC(2026, 10, 8, 12);
  const prev: MaspCoins = { [USDC]: { base: '150355823285', height: 6_966_000, at: NOW - H, ts: TS - H } };
  it('the block\'s word replaces the stored one, stamped with the block and its time; a fall to 0 is kept on the entry', () => {
    const { next, falls } = mergeMaspCoins(prev, { [USDC]: { base: '0', via: 'post-balance' } }, H6966497, TS, NOW);
    expect(falls).toEqual([{ token: USDC, fromBase: 150355823285n, toBase: 0n, height: H6966497, ts: TS }]);
    expect(next[USDC]).toEqual({ base: '0', height: H6966497, at: NOW, ts: TS, fell: { fromBase: '150355823285', toBase: '0', height: H6966497, ts: TS, at: NOW, posted: false } });
  });
  it('a block at or below the stored one changes nothing; a first-seen coin or an IBC word is never a fall', () => {
    expect(mergeMaspCoins(prev, { [USDC]: { base: '0', via: 'post-balance' } }, 6_966_000, TS, NOW)).toEqual({ next: prev, falls: [] });
    const first = mergeMaspCoins({}, { [USDC]: { base: '0', via: 'post-balance' } }, H6966497, TS, NOW);
    expect(first.falls).toEqual([]);
    expect(first.next[USDC]).toEqual({ base: '0', height: H6966497, at: NOW, ts: TS });
    const ibc = mergeMaspCoins(prev, { [USDC]: { base: null, via: 'ibc' } }, H6966497, TS, NOW);
    expect(ibc.falls).toEqual([]);
    expect(ibc.next[USDC]).toEqual({ base: null, height: H6966497, at: NOW, ts: TS });
  });
  it('the rule: to 0, or to at most half; not a smaller fall, not a rise', () => {
    expect(isCoinFall(100n, 0n)).toBe(true);
    expect(isCoinFall(100n, 50n)).toBe(true);
    expect(isCoinFall(100n, 51n)).toBe(false);
    expect(isCoinFall(100n, 100n)).toBe(false);
    expect(isCoinFall(0n, 0n)).toBe(false);
    expect(isCoinFall(100n, 200n)).toBe(false);
  });
  it('the stored row is read strictly: a malformed entry is dropped, never guessed', () => {
    expect(maspCoinsOf({ [USDC]: { base: '12', height: 5, at: 1, ts: 2, fell: { fromBase: '24', toBase: '12', height: 5, ts: 2, at: 1, posted: true } }, bad: { base: '1', height: 1, at: 1 }, [STATOM]: { base: 1.5, height: 1, at: 1 } }))
      .toEqual({ [USDC]: { base: '12', height: 5, at: 1, ts: 2, fell: { fromBase: '24', toBase: '12', height: 5, ts: 2, at: 1, posted: true } } });
    expect(maspCoinsOf(null)).toEqual({});
    expect(maspCoinsOf('x')).toEqual({});
  });
});

describe('the operator\'s line: the floor and the words', () => {
  const fall: CoinFall = { token: USDC, fromBase: 150355823285n, toBase: 0n, height: H6966497, ts: TS };
  it('Noble USDC counts at a dollar; the coins the price list quotes take their minute key; the others have no quote here', () => {
    expect(MASP_COIN_QUOTE['USDC (Noble)']).toEqual({ stable: true });
    expect(MASP_COIN_QUOTE['USDC (via Osmosis)']).toEqual({ stable: true });
    expect(MASP_COIN_QUOTE.OSMO).toEqual({ metric: QUOTE_KEYS.OSMO });
    expect(MASP_COIN_QUOTE.allETH).toEqual({ metric: QUOTE_KEYS.ETH });
    expect(MASP_COIN_QUOTE.stATOM).toBeUndefined();
    expect(coinOf(USDC)).toEqual({ symbol: 'USDC (Noble)', decimals: 6 });
    expect(coinOf('tnam1pyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqej6juv')).toBeNull();
  });
  it('the value before the fall at the quote decides against the floor; no quote, no value', () => {
    expect(fallValueUsd(fall, 6, 1)).toBeCloseTo(150_355.823285, 6);
    expect(fallValueUsd(fall, 6, 1)! >= COIN_FALL_FLOOR_USD).toBe(true);
    expect(fallValueUsd({ ...fall, fromBase: 999_999_999n }, 6, 1)! < COIN_FALL_FLOOR_USD).toBe(true);
    expect(fallValueUsd(fall, 6, null)).toBeNull();
    expect(fallValueUsd(fall, 6, 0)).toBeNull();
    expect(COIN_FALL_FLOOR_USD).toBe(1000);
  });
  it('the words name the coin, both amounts, the share, the block and its time, and the value at the quote; nothing else', () => {
    const line = coinFallWords(fall, 'USDC (Noble)', 6, 150_355.823285, null);
    expect(line).toBe("Shielded pool, USDC (Noble): the pool's balance went from 150,355.823285 to 0 USDC (Noble) in block 6,966,497 (2026-06-18 09:25 UTC), 100% of it. Before the block the balance was worth about 150,356 US dollars at the site's quote.");
    const half = coinFallWords({ ...fall, fromBase: 10_000_000_000n, toBase: 4_000_000_000n }, 'OSMO', 6, 1_800, Date.UTC(2026, 5, 18, 9, 24));
    expect(half).toBe("Shielded pool, OSMO: the pool's balance went from 10,000 to 4,000 OSMO in block 6,966,497 (2026-06-18 09:25 UTC), 60% of it. Before the block the balance was worth about 1,800 US dollars at the site's quote at 2026-06-18 09:24 UTC.");
    for (const w of [line, half]) expect(w).not.toMatch(BANNED);
    expect(coinAmountWords(150355823285n, 6)).toBe('150,355.823285');
    expect(coinAmountWords(1n, 18)).toBe('0.000000000000000001');
    expect(coinAmountWords(0n, 6)).toBe('0');
    expect(coinUnits('150355823285', 6)).toBeCloseTo(150_355.823285, 6);
    expect(coinDailyKey('USDC (Noble)')).toBe('masp.coin.usdc_noble.daily');
    expect(coinDailyKey('allETH')).toBe('masp.coin.alleth.daily');
  });
});

describe('the daily job: part \'shielded coins\'', () => {
  // 02:03 UTC on 9 Nov 2026: inside the daily job's window
  const NOW = Date.UTC(2026, 10, 9, 2, 3);
  const rewards = async () => ({ total: 27_347_610_418_808n, height: 8_517_986, provider: 'StakeAndRelax' });
  const env = (db: TestD1) => ({ DB: db } as any);
  const seedCoins = (db: TestD1, coins: MaspCoins) => db.raw.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)').run(MASP_COINS_KV, JSON.stringify(coins), NOW);
  it('not the day\'s work while the hub has stored no coin: no row, no message', async () => {
    const db = testD1();
    const r = (await daily(env(db), NOW, { health: [], maspRewards: rewards, validators: async () => [] }))!;
    expect(r.ran).not.toContain('shielded coins');
    expect(r.waiting.some((w) => w.startsWith('shielded coins'))).toBe(false);
    expect(all(db, 'SELECT * FROM masp_coins_daily')).toEqual([]);
  });
  it('reads each stored coin from the chain once; a read that answers is the row\'s figure, a read that fails leaves the post-balance and is asked again next hour', async () => {
    const db = testD1();
    seedCoins(db, {
      [USDC]: { base: '0', height: H6966497, at: NOW - D, ts: TS },
      // seen only by an IBC mint: no post-balance to fall back on
      [STATOM]: { base: null, height: 8_000_000, at: NOW - D },
    });
    const asked: string[] = [];
    const health: SourceHealth[] = [];
    const failing = async (token: string) => { asked.push(token); if (token === STATOM) throw new Error('abci: deadline passed'); return { base: '4990513672', height: 8_517_986, provider: 'StakeAndRelax' }; };
    const r = (await daily(env(db), NOW, { health, maspRewards: rewards, validators: async () => [], coinBalance: failing }))!;
    expect(asked.sort()).toEqual([USDC, STATOM].sort());
    expect(r.ran).not.toContain('shielded coins');
    expect(r.waiting).toContain('shielded coins: 1 of 2 coins could not be read from the chain, so their rows carry the last post-balance (1 with none, so no row); asked again next hour');
    expect(all(db, 'SELECT * FROM masp_coins_daily')).toEqual([
      { day: '2026-11-09', token: USDC, symbol: 'USDC (Noble)', base: '4990513672', units: 4990.513672, basis: 'read', height: 8_517_986, provider: 'StakeAndRelax', at: NOW },
    ]);
    expect(all(db, 'SELECT ts, value FROM metrics WHERE key = ?', coinDailyKey('USDC (Noble)'))).toEqual([{ ts: Date.UTC(2026, 10, 9), value: 4990.513672 }]);
    // the same hour: not asked again
    asked.length = 0;
    const same = (await daily(env(db), NOW + 60_000, { health, maspRewards: rewards, validators: async () => [], coinBalance: failing }))!;
    expect(asked).toEqual([]);
    expect(same.waiting).toContain("shielded coins: a coin's pool balance could not be read this hour; asked again next hour");
    // next hour, both answer: done for the day, the unknown coin's row written by address with no symbol and no metric
    const ok = async (token: string) => ({ base: token === USDC ? '4990513672' : '5000000', height: 8_517_986, provider: 'Polkachu' });
    const again = (await daily(env(db), NOW + H, { health, maspRewards: rewards, validators: async () => [], coinBalance: ok }))!;
    expect(again.ran).toContain('shielded coins');
    expect(all(db, 'SELECT token, symbol, base, units, basis, provider FROM masp_coins_daily ORDER BY token')).toEqual([
      { token: STATOM, symbol: 'stATOM', base: '5000000', units: 5, basis: 'read', provider: 'Polkachu' },
      { token: USDC, symbol: 'USDC (Noble)', base: '4990513672', units: 4990.513672, basis: 'read', provider: 'Polkachu' },
    ]);
  });
  it('a read that fails for a coin with a post-balance writes that figure, said so', () => {
    const coins: MaspCoins = { [USDC]: { base: '150355823285', height: 6_966_000, at: 1, ts: 2 }, [STATOM]: { base: null, height: 1, at: 1 } };
    const f = coinDayFigures(coins, { [USDC]: null, [STATOM]: null }, 9);
    expect(f).toEqual({ figures: [{ token: USDC, base: '150355823285', basis: 'post-balance', height: 6_966_000, provider: null, at: 9 }], notRead: [USDC, STATOM], unknown: [STATOM] });
    const stmts = coinDayStmts('2026-11-09', f.figures);
    expect(stmts).toHaveLength(2);
    expect(stmts[0].params).toEqual(['2026-11-09', USDC, 'USDC (Noble)', '150355823285', 150_355.823285, 'post-balance', 6_966_000, null, 9]);
    expect(stmts[1].params).toEqual([Date.UTC(2026, 10, 9), 'masp.coin.usdc_noble.daily', 150_355.823285]);
    // a token the table does not name: a row by address, no metric
    const unknown = coinDayStmts('2026-11-09', [{ token: 'tnam1pyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqej6juv', base: '7', basis: 'read', height: 1, provider: 'A', at: 9 }]);
    expect(unknown).toHaveLength(1);
    expect(unknown[0].params.slice(2, 5)).toEqual([null, '7', null]);
  });
});

// ---------------------------------------------------------------- the hub, on the real block

const hubOf = (db: TestD1) => Object.assign(Object.create(LiveHub.prototype), {
  env: { DB: db }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote: new HubQuote(async () => null, async () => null),
}) as any;

describe('the live hub records the pool\'s coins and its newest scanned block', () => {
  it('scanning block 6,966,497 writes the coin\'s post-balance to kv masp.coins with the fall from the stored balance, the masp_seen row with the block\'s time, and kv namada.scanned', async () => {
    const db = testD1();
    db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(String(H6966497 - 1));
    db.raw.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, 0)').run(MASP_COINS_KV, JSON.stringify({ [USDC]: { base: '150355823285', height: 6_966_000, at: 1, ts: TS - H } }));
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = new URL(String(u));
      if (url.pathname === '/status') return Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(H6966497), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
      if (url.pathname === '/blockchain') {
        const lo = Number(url.searchParams.get('minHeight')), hi = Math.min(Number(url.searchParams.get('maxHeight')), H6966497);
        const metas = [];
        for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: NAMADA.chainId, height: String(h), time: new Date(TS - (H6966497 - h) * 6000).toISOString() }, num_txs: '0' });
        return Response.json({ result: { last_height: String(H6966497), block_metas: metas } });
      }
      if (url.pathname === '/block_results') return Number(url.searchParams.get('height')) === H6966497 ? Response.json(RESULTS) : Response.json({ result: { height: url.searchParams.get('height'), end_block_events: [] } });
      throw new Error(`not served: ${url.pathname}`);
    }));
    await hubOf(db).scanNamada();
    expect(kvOf(db, 'namada.cursor')).toBe(H6966497);
    const coins = kvOf(db, MASP_COINS_KV);
    expect(coins[USDC]).toMatchObject({ base: '0', height: H6966497, ts: TS, fell: { fromBase: '150355823285', toBase: '0', height: H6966497, ts: TS, posted: false } });
    expect(all(db, 'SELECT height, block_index, batch_index, kind, ts FROM masp_seen')).toEqual([{ height: H6966497, block_index: 0, batch_index: 0, kind: 'transfer', ts: TS }]);
    expect(kvOf(db, SCANNED_KV)).toMatchObject({ height: H6966497, ts: TS });
    expect(all(db, 'SELECT kind, from_addr, amount_num, counter_denom FROM flows')).toEqual([{ kind: 'unshield', from_addr: MASP, amount_num: 150_355.823285, counter_denom: 'USDC (Noble)' }]);
    // no operator post without the send gate: nothing was fetched from a webhook
    const posted = (fetch as any).mock.calls.map((c: any[]) => String(c[0])).filter((u: string) => !/\/(status|blockchain|block_results)/.test(u));
    expect(posted).toEqual([]);
  });
});
