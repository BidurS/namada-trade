// Security review (2026-10-22), pool addresses from the quote service: every address the Osmosis quote service lists
// as a NAM pool became a 'pool' label, which leaves the address out of every holder list, count and rank, replaced a
// genesis label or a wallet's own tag, and was taken by the live hub as a pool, so a NAM transfer to it was booked as
// liquidity. The answer was not checked, so one that named a Namada holder or an Osmosis wallet did all of this, and
// the label stayed after the answer was right again. Now the quote service's word is taken only for an address shaped
// like an Osmosis pool account (a checksummed osmo1 address of 32 bytes), and any other is said in the source's health.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { bech32 } from '@scure/base';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { fetchNamPools } from '../worker/src/sources/sqs';
import { runCron } from '../worker/src/cron';
import { parseOsmosisTx, type NormTx } from '../worker/src/parse/osmosis';
import { listingBalanceStmts } from '../worker/src/holders';
import { COHORT_LABELLED_SQL } from '../worker/src/series-sql';
import { stmt } from '../worker/src/db';
import { app } from '../worker/src/api';
import { isPoolAccount } from '../worker/src/util';
import { NAM, OSMOSIS } from '../worker/src/config';
import { testD1, insert, runStmts, type TestD1 } from './d1-sqlite';
import type { HoldersResponse } from '../shared/types';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const H = 3600000;
const USDC = OSMOSIS.usdcDenom;
// Real NAM pools as the quote service listed them on 2026-10-22: one of each kind.
const CL_3005 = 'osmo1m459jtgn77tz8cffvthq5jh0erswxu9872mjd9qde546mslc6udq85we5r';
const BALANCER_3007 = 'osmo1zgn0stc4upnezcnyhkrf775ducjfqs4cre57q0q5j6flqgd2tf8sxz06mz';
const STABLE_3398 = 'osmo13dwjjmyuzscw2kf4hz55gehea53kd6hmc9xnttquxnhykf0r86yqxexuae';
const COSMWASM_3008 = 'osmo1cf6jdap430ugk6c27cdm5stqkq7z3rkgfl5ps5nnw3d5409sw3vql4364c';
const realPools = [
  { type: 2, chain_model: { id: 3005, address: CL_3005 }, balances: [{ denom: USDC, amount: '155773361' }, { denom: NAM.osmoDenom, amount: '660434050388' }], liquidity_cap: '724', spread_factor: '0.002' },
  { type: 3, chain_model: { pool_id: 3008, contract_address: COSMWASM_3008 }, balances: [{ denom: USDC, amount: '1080' }, { denom: NAM.osmoDenom, amount: '910665411525' }], liquidity_cap: '748', spread_factor: '0' },
];

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const tn = (n: number) => `tnam1q${B32[n % 32]}${B32[Math.floor(n / 32) % 32]}${'q'.repeat(33)}qqqq`;
const wallet = (fill: number) => bech32.encode('osmo', bech32.toWords(new Uint8Array(20).fill(fill)));
const osmoUser = wallet(7), osmoSigner = wallet(9);
/** A 32-byte osmo1 address with its last character changed: the checksum fails. */
const badChecksum = CL_3005.slice(0, -1) + (CL_3005.endsWith('r') ? 'q' : 'r');
/** The pools a wrong answer adds: a Namada holder, the foundation's genesis address, a tagged wallet, an Osmosis wallet, a broken address. */
const wrongPools = [
  { type: 0, chain_model: { id: 9001, address: tn(5) }, balances: [{ denom: NAM.osmoDenom, amount: '1' }] },
  { type: 0, chain_model: { id: 9002, address: tn(10) }, balances: [] },
  { type: 0, chain_model: { id: 9003, address: tn(20) }, balances: [] },
  { type: 3, chain_model: { pool_id: 9004, contract_address: osmoUser }, balances: [] },
  { type: 2, chain_model: { id: 9005, address: badChecksum }, balances: [] },
];

/** 60 Namada holders of 1,000 to 60,000 NAM, the foundation's genesis label on tn(10), two backers, a wallet's own tag on tn(20). */
async function seeded() {
  const db = testD1();
  const T0 = Date.now();
  await runStmts(db, listingBalanceStmts(Array.from({ length: 60 }, (_, i) => ({ address: tn(i), balance: String((i + 1) * 1_000_000_000) })), 100, T0 - H));
  await runStmts(db, [
    stmt.label(tn(10), 'namada', 'Anoma Foundation', 'foundation', 'genesis', null, 1),
    stmt.label(tn(11), 'namada', 'Genesis: af_backers', 'backer', 'genesis', null, 1),
    stmt.label(tn(12), 'namada', 'Genesis: af_backers', 'backer', 'genesis', null, 1),
    stmt.userTag(tn(20), 'namada', 'my cold wallet', 'watch', tn(20), null, 1),
  ]);
  insert(db, 'metrics', [{ ts: T0 - 60000, key: 'supply.total', value: 1149000000 }]);
  return db;
}
const holders = async (db: TestD1) => (await (await app.request('/api/holders?chain=namada&limit=100', {}, { DB: db } as any)).json()) as HoldersResponse;
const labelOf = (db: TestD1, a: string) => db.raw.prepare('SELECT label, category, source, chain, author FROM labels WHERE address = ?').get(a);
const poolLabels = (db: TestD1) => (db.raw.prepare("SELECT address, chain FROM labels WHERE category = 'pool' ORDER BY address").all() as { address: string; chain: string }[]);
const healthOf = (db: TestD1) => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='source.health'").get() as { value: string }).value);

/** The quote service answers its pools with `pools`; every other producer answers 404 (the tick reads nothing else). */
function network(pools: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`${OSMOSIS.sqs}/pools?filter[denom]=`)) return new Response(JSON.stringify(pools), { status: 200 });
    return new Response('not here', { status: 404 });
  }));
}
/** One cron tick on a holder-sync minute, under fake timers. */
async function tick(db: TestD1) {
  const start = Math.floor(Date.now() / 600000) * 600000 + 5000;
  vi.useFakeTimers({ now: start, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let done = false, err: unknown = null;
  runCron({ DB: db, KEPLR_KEY: '' } as any).catch((e) => { err = e; }).finally(() => { done = true; });
  for (let i = 0; !done && i < 4000; i++) await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  if (err) throw err;
  expect(done).toBe(true);
}

describe('an address the quote service lists as a pool', () => {
  it('is a pool account only when it is a checksummed osmo1 address of 32 bytes: every kind of real pool is one', () => {
    for (const a of [CL_3005, BALANCER_3007, STABLE_3398, COSMWASM_3008]) expect(isPoolAccount(a), a).toBe(true);
    expect(isPoolAccount(osmoUser)).toBe(false); // a wallet's key address: 20 bytes
    expect(isPoolAccount(OSMOSIS.transferModule)).toBe(false); // a module account: 20 bytes
    expect(isPoolAccount(tn(5))).toBe(false);
    expect(isPoolAccount(badChecksum)).toBe(false);
    expect(isPoolAccount(CL_3005.toUpperCase().replace('OSMO1', 'osmo1'))).toBe(false);
    for (const v of ['', null, undefined, 3005, { address: CL_3005 }]) expect(isPoolAccount(v)).toBe(false);
  });

  it('a wrong address is left out of the pool and counted; the pool keeps its figures, and a right answer is read as before', async () => {
    network([...realPools, ...wrongPools]);
    const r = await fetchNamPools();
    expect(r.error).toBeUndefined();
    expect(r.refused).toBe(5);
    expect(r.pools).toHaveLength(7);
    expect(r.pools.filter((p) => p.address).map((p) => [p.id, p.address])).toEqual([['3008', COSMWASM_3008], ['3005', CL_3005]]);
    expect(r.pools.find((p) => p.id === '9001')).toMatchObject({ address: '', namReserve: 0.000001 });

    network(realPools);
    const ok = await fetchNamPools();
    expect(Object.keys(ok).sort()).toEqual(['at', 'pools']);
    expect(ok.pools.map((p) => [p.id, p.type, p.address, p.pair, p.liquidityUsd])).toEqual([
      ['3008', 'cosmwasm', COSMWASM_3008, 'NAM / USDC', 748],
      ['3005', 'concentrated', CL_3005, 'NAM / USDC', 724],
    ]);
  });

  it('the cron labels only real pool accounts: Namada holders, genesis labels and wallet tags stay, and the health says what was refused', async () => {
    const db = await seeded();
    expect((await holders(db)).total).toBe(60);
    network([...realPools, ...wrongPools]);
    await tick(db);

    expect(poolLabels(db)).toEqual([{ address: COSMWASM_3008, chain: 'osmosis' }, { address: CL_3005, chain: 'osmosis' }]);
    const after = await holders(db);
    expect(after.total).toBe(60);
    for (const a of [tn(5), tn(10), tn(20)]) expect(after.holders.map((h) => h.address), a).toContain(a);
    expect(after.categories!.counts.find((c) => c.category === 'foundation')?.n).toBe(1);
    expect(labelOf(db, tn(10))).toEqual({ label: 'Anoma Foundation', category: 'foundation', source: 'genesis', chain: 'namada', author: null });
    expect(labelOf(db, tn(20))).toMatchObject({ category: 'watch', source: 'user', author: tn(20) });
    expect((db.raw.prepare(COHORT_LABELLED_SQL).all() as { category: string; addrs: number }[]).find((c) => c.category === 'foundation')?.addrs).toBe(1);
    expect(healthOf(db)['Osmosis SQS (pools)']).toMatchObject({
      ok: false,
      note: 'The pool list named 5 addresses that are not an Osmosis pool account; they are not labelled a pool.',
    });
  });

  it('a right answer labels its pools and leaves the health as before', async () => {
    const db = await seeded();
    network(realPools);
    await tick(db);
    expect(poolLabels(db)).toEqual([{ address: COSMWASM_3008, chain: 'osmosis' }, { address: CL_3005, chain: 'osmosis' }]);
    expect(labelOf(db, CL_3005)).toMatchObject({ label: 'Osmosis Pool #3005 (NAM / USDC)', source: 'auto' });
    const h = healthOf(db)['Osmosis SQS (pools)'];
    expect(h.ok).toBe(true);
    expect(h.note).toBeUndefined();
  });

  it('the live hub takes only real pool accounts as pools: a NAM transfer to a wallet the answer named stays a transfer', async () => {
    network([...realPools, ...wrongPools]);
    const hub: any = Object.assign(Object.create(LiveHub.prototype), {
      osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() },
      quote: { refresh: async () => null }, lastPriceUsd: null, broadcast: () => {},
    });
    await hub.refreshContext();
    expect([...hub.osmoCtx.poolAddrs.entries()].sort()).toEqual([[COSMWASM_3008, '3008'], [CL_3005, '3005']]);

    const send = (to: string): NormTx => ({
      height: 1, hash: `POOLADDR${to.slice(-4)}`, code: 0, ts: Date.now(),
      events: [
        { type: 'tx', attributes: [{ key: 'fee_payer', value: osmoSigner }] },
        { type: 'transfer', attributes: [{ key: 'recipient', value: to }, { key: 'sender', value: osmoSigner }, { key: 'amount', value: `50000000000${NAM.osmoDenom}` }] },
      ],
    });
    expect(parseOsmosisTx(send(osmoUser), hub.osmoCtx).flows.map((f) => [f.kind, f.from, f.to, f.amount])).toEqual([['transfer', osmoSigner, osmoUser, 50_000]]);
    // a deposit to a real pool is still liquidity
    expect(parseOsmosisTx(send(CL_3005), hub.osmoCtx).flows.map((f) => [f.kind, f.from, f.to, f.amount])).toEqual([['lp_add', osmoSigner, null, 50_000]]);
  });
});
