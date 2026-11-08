// The Namada parser's coin table (worker/src/parse/namada.ts NAMADA_TOKENS): every coin indexer.namada.net listed on
// 2026-11-02, each address derived here from the IBC trace the table gives it, the two USDCs told apart, a coin missing
// from the table kept in the chain's own units, and a stored row named from its token address when it is read, with no
// write to the store.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bech32m } from '@scure/base';
import { NAMADA_TOKENS, parseNamadaBlock, tokenMeta, withCoinName } from '../worker/src/parse/namada';
import { rowToFlow } from '../worker/src/analytics';
import { app } from '../worker/src/api';
import { moveTitle } from '../shared/flow-words';
import { NAM, NAMADA } from '../worker/src/config';
import { testD1, insert } from './d1-sqlite';
import type { FlowsResponse } from '../shared/types';

const MASP = NAMADA.internal.masp;
const USER = 'tnam1qq6wus66shjjwhe48c3udfyrh05vq62s0ysy3flp';
const NOBLE_USDC = 'tnam1pkl64du8p2d240my5umxm24qhrjsvh42ruc98f97';
const OSMOSIS_USDC = 'tnam1p443nycjk2w0q3al3vfnw3gw7w4qga07psfqnjtm';
const ALL_ETH = 'tnam1phtm05yrtdw24jjjzzvnnn4svnvpa0qf3v9zggvm';

/** indexer.namada.net /api/v1/chain/token on 2026-11-02, as it wrote each trace (the alloyed ones in lower case). */
const INDEXER_TOKENS: [string, string | null][] = [
  ['tnam1p5z8ruwyu7ha8urhq2l0dhpk2f5dv3ts7uyf2n75', 'transfer/channel-1/uosmo'],
  ['tnam1pkl64du8p2d240my5umxm24qhrjsvh42ruc98f97', 'transfer/channel-5/uusdc'],
  ['tnam1pk288t54tg99umhamwx998nh0q2dhc7slch45sqy', 'transfer/channel-4/upenumbra'],
  ['tnam1phv4vcuw2ftsjahhvg65w4ux8as09tlysuhvzqje', 'transfer/channel-6/unym'],
  ['tnam1pk6pgu4cpqeu4hqjkt6s724eufu64svpqgu52m3g', 'transfer/channel-7/untrn'],
  ['tnam1ph6xhf0defk65hm7l5ursscwqdj8ehrcdv300u4g', 'transfer/channel-0/stutia'],
  ['tnam1pklj3kwp0cpsdvv56584rsajty974527qsp8n0nm', 'transfer/channel-3/utia'],
  ['tnam1p5z5538v3kdk3wdx7r2hpqm4uq9926dz3ughcp7n', 'transfer/channel-0/stuatom'],
  ['tnam1p4px8sw3am4qvetj7eu77gftm4fz4hcw2ulpldc7', 'transfer/channel-0/stuosmo'],
  ['tnam1pkg30gnt4q0zn7j00r6hms4ajrxn6f5ysyyl7w9m', 'transfer/channel-2/uatom'],
  ['tnam1q9gr66cvu4hrzm0sd5kmlnjje82gs3xlfg3v6nu7', null],
  ['tnam1p443nycjk2w0q3al3vfnw3gw7w4qga07psfqnjtm', 'transfer/channel-1/transfer/channel-750/uusdc'],
  ['tnam1pkfnp8vx0rdrsxyagq5ffle60hv4jwag7g06h7gx', 'transfer/channel-1/transfer/channel-85077/uom'],
  ['tnam1p5hpxyzdpyjdmdt5axx0q8sl6tvfzdmehse9ca7z', 'transfer/channel-1/factory/osmo1z6r6qdknhgsc0zeracktgpcxf43j6sekq07nw8sxduc9lg0qjjlqfu25e3/alloyed/allbtc'],
  ['tnam1pk9mqcwc8q497enfp9pgrx7x7kxfqz9etu0ur067', 'transfer/channel-1/factory/osmo1n3n75av8awcnw4jl62n3l48e6e4sxqmaf97w5ua6ddu4s475q5qq9udvx4/alloyed/allsol'],
  ['tnam1phtm05yrtdw24jjjzzvnnn4svnvpa0qf3v9zggvm', 'transfer/channel-1/factory/osmo1k6c8jln7ejuqwtqmay3yvzrg3kueaczl96pk067ldg8u835w0yhsw27twm/alloyed/alleth'],
];

/** namada_core's address of a coin from another chain: discriminant 13 (IbcToken), the first 20 bytes of the trace's sha256, bech32m "tnam". */
const ibcTokenAddress = (trace: string) =>
  bech32m.encode('tnam', bech32m.toWords(Uint8Array.from([13, ...createHash('sha256').update(trace).digest().subarray(0, 20)])));

type L = [string, string, string]; // account, token, base units
const transfer = (src: L[], dst: L[]) => ({
  type: 'token/transfer',
  attributes: [
    { key: 'token-event-descriptor', value: 'transfer-from-wasm' },
    { key: 'hash', value: 'AB'.repeat(32) },
    { key: 'inner-tx-hash', value: 'CD'.repeat(32) },
    { key: 'source-accounts', value: JSON.stringify(src.map(([a, t, n]) => [[`internal-address/${a}`, t], n])) },
    { key: 'target-accounts', value: JSON.stringify(dst.map(([a, t, n]) => [[`internal-address/${a}`, t], n])) },
  ],
});
const mint = (token: string, units: string) => ({
  type: 'token/mint',
  attributes: [
    { key: 'token-event-descriptor', value: 'ibc' },
    { key: 'token-address', value: token },
    { key: 'target-account', value: `internal-address/${MASP}` },
    { key: 'amount', value: units },
    { key: 'hash', value: 'EF'.repeat(32) },
  ],
});
const parse = (...events: object[]) => parseNamadaBlock({ height: 8_500_000, ts: 1, events: events as any }, null).flows;

describe('the coin table', () => {
  it('holds every coin the indexer lists, NAM and fifteen from other chains, each address derived from its trace', () => {
    expect(Object.keys(NAMADA_TOKENS).sort()).toEqual(INDEXER_TOKENS.map(([a]) => a).sort());
    expect(NAMADA_TOKENS[NAM.namadaToken]).toEqual({ symbol: 'NAM', decimals: 6 });
    for (const [address, indexerTrace] of INDEXER_TOKENS) {
      if (indexerTrace == null) { expect(address).toBe(NAM.namadaToken); continue; }
      const { trace } = NAMADA_TOKENS[address];
      // the chain hashes the trace as the table writes it; the indexer differs from it only in case
      expect(trace?.toLowerCase(), address).toBe(indexerTrace.toLowerCase());
      expect(ibcTokenAddress(trace!), trace).toBe(address);
    }
  });

  it('names each coin once, the two USDCs by the way they came, with the decimals of the coin they came from', () => {
    const names = Object.values(NAMADA_TOKENS).map((t) => t.symbol);
    expect(new Set(names).size).toBe(names.length);
    expect(NAMADA_TOKENS[NOBLE_USDC]).toMatchObject({ symbol: 'USDC (Noble)', decimals: 6 });
    expect(NAMADA_TOKENS[OSMOSIS_USDC]).toMatchObject({ symbol: 'USDC (via Osmosis)', decimals: 6 });
    expect(Object.fromEntries(Object.values(NAMADA_TOKENS).filter((t) => t.decimals !== 6).map((t) => [t.symbol, t.decimals]))).toEqual({ allBTC: 8, allSOL: 9, allETH: 18 });
  });

  it('keeps a coin missing from the table in the chain\'s own units, and says so in its name', () => {
    expect(tokenMeta('tnam1pzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toEqual({ symbol: 'units of tnam1pzz…', decimals: 0 });
  });
});

describe('the parser names each coin and records the decimals it read the amount with', () => {
  it('a Noble USDC unshield is 59.2 USDC (Noble), not "tnam1pkl…"', () => {
    const [f] = parse(transfer([[MASP, NOBLE_USDC, '59200000']], [[USER, NOBLE_USDC, '59200000']]));
    expect(f).toMatchObject({ kind: 'unshield', amount: 59.2, counterDenom: 'USDC (Noble)', meta: { tokenSymbol: 'USDC (Noble)', tokenAddress: NOBLE_USDC, tokenDecimals: 6 } });
    expect(moveTitle(f)).toBe('59.2 USDC (Noble) moved out of the shielded set');
  });

  it('an allETH shield straight from another chain is read with 18 decimals', () => {
    const [f] = parse(mint(ALL_ETH, '1500000000000000000'));
    expect(f).toMatchObject({ kind: 'shield', amount: 1.5, meta: { descriptor: 'ibc-masp', tokenSymbol: 'allETH', tokenDecimals: 18 } });
  });

  it('a coin missing from the table keeps its base units, never a guessed scale', () => {
    const coin = 'tnam1pzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
    const [f] = parse(transfer([[USER, coin, '59200000']], [[MASP, coin, '59200000']]));
    expect(f).toMatchObject({ kind: 'shield', amount: 59_200_000, meta: { tokenSymbol: 'units of tnam1pzz…', tokenDecimals: 0 } });
  });
});

describe('a re-derive of the stored rows (scripts/rederive-namada.ts)', () => {
  it("writes every key the parser puts in a coin row's meta, the decimals among them", () => {
    // the script runs against the database when loaded, so its key list is read from its text
    const src = readFileSync(new URL('../scripts/rederive-namada.ts', import.meta.url), 'utf8');
    const keys = JSON.parse((src.match(/const PARSER_KEYS = (\[[^\]]*\])/)?.[1] ?? '[]').replace(/'/g, '"')) as string[];
    expect(keys).toContain('tokenDecimals');
    const rows = [...parse(transfer([[MASP, NOBLE_USDC, '59200000']], [[USER, NOBLE_USDC, '59200000']])), ...parse(mint(ALL_ETH, '1500000000000000000'))];
    for (const f of rows) for (const k of Object.keys(f.meta ?? {})) expect(keys, k).toContain(k);
  });
});

describe('a stored row is named from its token address when it is read', () => {
  it('names a row stored before its coin was in the table, only when its amount is in the table\'s units', () => {
    // stored by builds before 2026-11-02: a coin missing from the table under its address's first characters, read with 6 decimals
    expect(withCoinName({ tokenSymbol: 'tnam1pkl…', tokenAddress: NOBLE_USDC })).toEqual({ tokenSymbol: 'USDC (Noble)', tokenAddress: NOBLE_USDC });
    expect(withCoinName({ tokenSymbol: 'USDC', tokenAddress: OSMOSIS_USDC })).toMatchObject({ tokenSymbol: 'USDC (via Osmosis)' });
    // read with 6 decimals, but the coin has 18: the stored name stays with the stored amount
    expect(withCoinName({ tokenSymbol: 'tnam1pht…', tokenAddress: ALL_ETH })).toMatchObject({ tokenSymbol: 'tnam1pht…' });
    // kept in base units while the coin was missing from the table
    expect(withCoinName({ tokenSymbol: 'units of tnam1pkl…', tokenAddress: NOBLE_USDC, tokenDecimals: 0 })).toMatchObject({ tokenSymbol: 'units of tnam1pkl…' });
    expect(withCoinName({ tokenSymbol: 'units of tnam1pkl…', tokenAddress: NOBLE_USDC, tokenDecimals: 6 })).toMatchObject({ tokenSymbol: 'USDC (Noble)' });
  });

  it('returns NAM rows, rows already named and coins missing from the table as stored', () => {
    const named = { tokenSymbol: 'OSMO', tokenAddress: 'tnam1p5z8ruwyu7ha8urhq2l0dhpk2f5dv3ts7uyf2n75' };
    expect(withCoinName(named)).toBe(named);
    const nam = { descriptor: 'transfer-from-wasm' };
    expect(withCoinName(nam)).toBe(nam);
    expect(withCoinName(null)).toBeNull();
    const unknown = { tokenSymbol: 'tnam1pzz…', tokenAddress: 'tnam1pzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' };
    expect(withCoinName(unknown)).toBe(unknown);
  });

  const T = Date.UTC(2026, 9, 25, 12, 0);
  const stored = {
    id: 'namada:AA:0', chain: 'namada', height: 8_421_952, ts: T, tx_hash: 'AA', kind: 'shield', from_addr: USER, to_addr: MASP,
    amount_num: 59.2, counter_denom: 'tnam1pkl…', counter_amount: 59.2,
    meta: JSON.stringify({ descriptor: 'transfer-from-wasm', tokenSymbol: 'tnam1pkl…', tokenAddress: NOBLE_USDC }),
  };

  it('rowToFlow gives the row its coin\'s name and its counter coin the same, and the title says it', () => {
    const f = rowToFlow(stored);
    expect(f.meta).toMatchObject({ tokenSymbol: 'USDC (Noble)', tokenAddress: NOBLE_USDC });
    expect(f.counterDenom).toBe('USDC (Noble)');
    expect(moveTitle(f)).toBe('59.2 USDC (Noble) moved into the shielded set');
    // an Osmosis trade's counter coin is its own and is never renamed
    expect(rowToFlow({ ...stored, id: 'osmosis:B', chain: 'osmosis', kind: 'sell', counter_denom: 'USDC', meta: null }).counterDenom).toBe('USDC');
  });

  it('GET /api/flows names the row and the store keeps it as written', async () => {
    const db = testD1();
    insert(db, 'flows', [stored]);
    const res = await app.request(`/api/flows?chain=namada&at=${T + 60_000}`, {}, { DB: db } as any);
    const body = (await res.json()) as FlowsResponse;
    expect(body.flows.map((f) => [f.meta?.tokenSymbol, f.counterDenom])).toEqual([['USDC (Noble)', 'USDC (Noble)']]);
    expect(db.raw.prepare('SELECT counter_denom, json_extract(meta, \'$.tokenSymbol\') sym FROM flows').get()).toEqual({ counter_denom: 'tnam1pkl…', sym: 'tnam1pkl…' });
  });
});
