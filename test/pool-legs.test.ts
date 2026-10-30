// Osmosis pool completeness (2026-10-29): the pools' legs in their other coins. The parser keeps NAM only (moves are
// NAM deltas), and every Osmosis query needs a NAM transfer, a swap in 3005 or a NAM-channel packet, so a transaction
// that moves only a pool's USDC or OSMO left no row anywhere: in the 7 days to 2026-10-29, 9 bids placed or cancelled
// on the 3008 order book and the USDC-only position withdrawal EBDEAC7A... from 3005 (-69.912075 USDC), both fixtures
// here as the chain gave them. Now poolLegsOf (worker/src/parse/osmosis.ts) gives each bank leg in another coin with a
// NAM pool's address on one end, the hub writes them to pool_legs (migration 0018) beside a transaction's NAM rows, in a
// batch of their own that never holds up those rows, and the 5-minute catch-up search reads each pool's address both
// ways (osmosisPoolQueries; a quiet pool costs one transaction's read). No NAM figure reads pool_legs: the NAM rows
// a transaction makes are the same with it as without it, and no SQL outside the write names the table.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub, OSMOSIS_QUERIES } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { normFromTxSearch, osmoAssets, parseOsmosisTx, poolLegsOf, type NormTx } from '../worker/src/parse/osmosis';
import { osmosisPoolQueries } from '../worker/src/sources/osmosis';
import { OSMOSIS, NAM } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => vi.unstubAllGlobals());

const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', f), 'utf8'));
const P3005 = 'osmo1m459jtgn77tz8cffvthq5jh0erswxu9872mjd9qde546mslc6udq85we5r';
const P3008 = 'osmo1cf6jdap430ugk6c27cdm5stqkq7z3rkgfl5ps5nnw3d5409sw3vql4364c';
const P3368 = 'osmo1h6zkrf476ha3csjmgf6eneh3p43ltmjlppvyzpmpyfxts0zk3k0s288e7l';
const P3009 = 'osmo1rcl39flt5ua3t92vtwj7xllj9u2ucmrsjdhl945jc25f6zxvnvns5rtv6l';
const pools = () => new Map([[P3005, '3005'], [P3008, '3008'], [P3368, '3368'], [P3009, '3009']]);
const USDC = OSMOSIS.usdcDenom;
const withdraw = fx('osmo_pool3005_usdc_withdraw.json')[0];
const bid = fx('osmo_pool3008_bid.json')[0];
const swaps = fx('osmo_swap.json');

describe('poolLegsOf: a pool\'s legs in its other coins', () => {
  it('the USDC-only withdrawal from 3005 and a bid on the 3008 book: no NAM row, one USDC leg each', () => {
    for (const [t, pool, address, delta] of [[withdraw, '3005', P3005, '-69912075'], [bid, '3008', P3008, '24999710']] as const) {
      const norm = normFromTxSearch(t, 1);
      const nam = parseOsmosisTx(norm, { poolAddrs: pools(), priceUsd: null, assets: osmoAssets() });
      expect(nam.flows).toEqual([]);
      expect(nam.moves).toEqual([]);
      expect(poolLegsOf(norm, pools())).toEqual([{ chain: 'osmosis', poolId: pool, address, height: Number(t.height), ts: 1, txHash: t.hash, idx: 1000, denom: USDC, delta }]);
    }
  });

  it('a swap: the pool\'s counter legs are its hops\' own coins, and its NAM stays in the moves alone', () => {
    for (const t of swaps) {
      const norm = normFromTxSearch(t, 1);
      const legs = poolLegsOf(norm, pools());
      expect(legs.length).toBeGreaterThan(0);
      expect(legs.every((l) => l.denom !== NAM.osmoDenom)).toBe(true);
      // each pool's legs net to what its token_swapped events say it took in and paid out in that coin
      const hops = new Map<string, bigint>();
      for (const e of t.tx_result.events) {
        if (e.type !== 'token_swapped') continue;
        const a = Object.fromEntries(e.attributes.map((x: any) => [x.key, x.value]));
        const addr = [...pools()].find(([, id]) => id === a.pool_id)?.[0];
        if (!addr) continue;
        for (const [coins, sign] of [[a.tokens_in, 1n], [a.tokens_out, -1n]] as const) {
          const m = /^(\d+)(.+)$/.exec(coins)!;
          if (m[2] !== NAM.osmoDenom) hops.set(`${addr} ${m[2]}`, (hops.get(`${addr} ${m[2]}`) ?? 0n) + sign * BigInt(m[1]));
        }
      }
      const net = new Map<string, bigint>();
      for (const l of legs) net.set(`${l.address} ${l.denom}`, (net.get(`${l.address} ${l.denom}`) ?? 0n) + BigInt(l.delta));
      expect(net).toEqual(hops);
    }
  });

  it('nothing for a failed transaction, a pool unknown to the map, a leg from a pool to itself; a leg of two coins gives two', () => {
    const tx = (events: NormTx['events'], code = 0): NormTx => ({ height: 5, hash: 'H', code, ts: 1, events });
    const leg = (sender: string, recipient: string, amount: string) => ({ type: 'transfer', attributes: [{ key: 'recipient', value: recipient }, { key: 'sender', value: sender }, { key: 'amount', value: amount }] });
    expect(poolLegsOf(tx([leg('osmo1user', P3005, `5${USDC}`)], 11), pools())).toEqual([]);
    expect(poolLegsOf(tx([leg('osmo1user', 'osmo1other', `5${USDC}`)]), pools())).toEqual([]);
    expect(poolLegsOf(tx([leg(P3005, P3005, `5${USDC}`)]), pools())).toEqual([]);
    expect(poolLegsOf(tx([leg('osmo1user', P3368, `7uosmo,${3 * 1e6}${NAM.osmoDenom},0${USDC},9${USDC}`)]), pools()).map((l) => [l.poolId, l.denom, l.delta])).toEqual([['3368', 'uosmo', '7'], ['3368', USDC, '9']]);
    // pool to pool: one leg at each end
    expect(poolLegsOf(tx([leg(P3368, P3009, '4uosmo')]), pools()).map((l) => [l.poolId, l.delta])).toEqual([['3368', '-4'], ['3009', '4']]);
  });
});

/** A hub over `db`, made without the constructor, with the pools known and its alerts recorded instead of sent. */
function hubOn(db: TestD1 | any, poolAddrs = pools()) {
  const hub = Object.assign(Object.create(LiveHub.prototype), {
    env: { DB: db },
    seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0, osmoHeight: 0,
    sessions: new Set(), lastPriceUsd: null, needSweep: false,
    osmoCtx: { poolAddrs, priceUsd: null, assets: osmoAssets() },
    quote: new HubQuote(async () => null, async () => null),
  }) as any;
  hub.alerted = [] as unknown[];
  hub.alertFlows = vi.fn(async (flows: unknown[]) => { hub.alerted.push(...flows); });
  return hub;
}
const namRows = (db: TestD1) => ({
  flows: db.raw.prepare('SELECT id, kind, amount_num, from_addr, to_addr, counter_denom, counter_amount, pool_id FROM flows ORDER BY id').all().map((r: object) => ({ ...r })),
  moves: db.raw.prepare('SELECT address, tx_hash, idx, delta_num FROM moves ORDER BY tx_hash, idx, address').all().map((r: object) => ({ ...r })),
});
const legRows = (db: TestD1) => db.raw.prepare('SELECT pool_id, address, tx_hash, idx, denom, delta, height FROM pool_legs ORDER BY tx_hash, idx, address, denom').all().map((r: object) => ({ ...r }));
const streamed = (t: any) => ({ result: { data: { value: { TxResult: { height: String(t.height), result: { code: 0, events: t.tx_result.events } } } }, events: { 'tx.hash': [t.hash] } } });

describe('the stream: a swap\'s pool legs beside its NAM rows', () => {
  it('the NAM rows are the same with the legs as without the table, and the legs are stored', async () => {
    const withTable = testD1(), without = testD1();
    without.exec('DROP TABLE pool_legs');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const db of [withTable, without]) {
      const hub = hubOn(db);
      for (const t of swaps) await hub.handleOsmosisMessage(streamed(t));
    }
    // the database without the table refused the legs only: logged, never thrown, NAM rows stored
    expect(errors.mock.calls.some((c) => /pool legs of .* not written/.test(String(c[0])))).toBe(true);
    errors.mockRestore();
    expect(namRows(without)).toEqual(namRows(withTable));
    expect(namRows(withTable).flows.length).toBeGreaterThanOrEqual(swaps.length);
    const legs = legRows(withTable);
    const want = swaps.flatMap((t: any) => poolLegsOf(normFromTxSearch(t, 0), pools())).map((l: any) => ({ pool_id: l.poolId, address: l.address, tx_hash: l.txHash, idx: l.idx, denom: l.denom, delta: l.delta, height: l.height }));
    expect(legs).toEqual(want.sort((a: any, b: any) => (a.tx_hash < b.tx_hash ? -1 : a.tx_hash > b.tx_hash ? 1 : a.idx - b.idx || (a.address < b.address ? -1 : 1))));
    // written again (a catch-up finding it), nothing changes
    const again = hubOn(withTable);
    for (const t of swaps) await again.handleOsmosisMessage(streamed(t));
    expect(legRows(withTable)).toEqual(legs);
  });
});

describe('the stream keeps its four subscriptions', () => {
  it('with the pools known, the socket subscribes to OSMOSIS_QUERIES alone (CometBFT allows a client five by default)', () => {
    const hub = hubOn(testD1());
    const sent: any[] = [];
    hub.openedOsmosisWs({ send: (m: string) => sent.push(JSON.parse(m)), addEventListener: () => {}, close: () => {} });
    expect(sent.filter((m) => m.method === 'subscribe').map((m) => m.params.query)).toEqual(OSMOSIS_QUERIES.map((q) => `tm.event='Tx' AND ${q}`));
    expect(sent.length).toBeLessThanOrEqual(5);
  });
});

describe('the catch-up search: each pool\'s address both ways', () => {
  const CURSOR = 73_379_000, HEAD = 73_490_000;
  /** The node: the stream's four queries find nothing new; 3005's sends hold the withdrawal, 3008's receipts the bid. */
  function osmosis(db: TestD1) {
    const reads: { q: string; per: number; page: number }[] = [];
    const lists: Record<string, any[]> = {
      [`transfer.sender='${P3005}'`]: [withdraw],
      [`transfer.recipient='${P3008}'`]: [bid],
      // a quiet pool: its newest transaction is below the cursor
      [`transfer.recipient='${P3368}'`]: [{ ...swaps[2], height: String(CURSOR - 10) }],
    };
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const url = new URL(String(u));
      if (url.pathname.endsWith('/status')) return Response.json({ result: { sync_info: { latest_block_height: String(HEAD) } } });
      if (url.pathname.endsWith('/block')) return Response.json({ result: { block: { header: { time: new Date(Date.UTC(2026, 9, 28) + Number(url.searchParams.get('height')) % 1000).toISOString() } } } });
      if (!url.pathname.endsWith('/tx_search')) throw new Error(`unexpected ${url}`);
      const q = (url.searchParams.get('query') ?? '').slice(1, -1);
      const per = Number(url.searchParams.get('per_page')), page = Number(url.searchParams.get('page'));
      reads.push({ q, per, page });
      const list = lists[q] ?? [];
      return Response.json({ result: { txs: list.slice((page - 1) * per, page * per), total_count: String(list.length) } });
    }));
    void db;
    return reads;
  }
  async function seeded() {
    const db = testD1();
    await db.prepare("INSERT INTO kv (key, value, updated_at) VALUES ('osmosis.cursor', ?, 0)").bind(JSON.stringify({ height: CURSOR, at: 1 })).run();
    return db;
  }
  const cursorOf = (db: TestD1) => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='osmosis.cursor'").get() as any).value);

  it('the withdrawal and the bid are stored as pool legs at their block\'s time, with no NAM row, no broadcast and no alert; the cursor moves', async () => {
    const db = await seeded();
    const reads = osmosis(db);
    const hub = hubOn(db);
    const sent: unknown[] = [];
    hub.broadcast = (m: unknown) => sent.push(m);
    await hub.sweepOsmosis();
    expect(legRows(db)).toEqual([
      { pool_id: '3005', address: P3005, tx_hash: withdraw.hash, idx: 1000, denom: USDC, delta: '-69912075', height: Number(withdraw.height) },
      { pool_id: '3008', address: P3008, tx_hash: bid.hash, idx: 1000, denom: USDC, delta: '24999710', height: Number(bid.height) },
    ].sort((a, b) => (a.tx_hash < b.tx_hash ? -1 : 1)));
    const ts = db.raw.prepare('SELECT tx_hash, ts FROM pool_legs').all().map((r: any) => r.ts);
    expect(ts.every((x: number) => x >= Date.UTC(2026, 9, 28) && x < Date.UTC(2026, 9, 28) + 1000)).toBe(true);
    expect(namRows(db)).toEqual({ flows: [], moves: [] });
    expect(sent).toEqual([]);
    expect(hub.alerted).toEqual([]);
    expect(cursorOf(db)).toMatchObject({ height: HEAD });
    expect(cursorOf(db).error).toBeUndefined();
    // every pool's two queries were asked; a quiet one only for its newest transaction (one, newest first)
    const asked = [...pools().keys()].flatMap(osmosisPoolQueries);
    expect(asked.length).toBe(8);
    for (const q of asked) expect(reads.some((r) => r.q === q && r.per === 1)).toBe(true);
    for (const q of [`transfer.recipient='${P3368}'`, `transfer.sender='${P3368}'`, `transfer.recipient='${P3005}'`, `transfer.sender='${P3008}'`]) {
      expect(reads.filter((r) => r.q === q).map((r) => r.per)).toEqual([1]);
    }
    expect(reads.filter((r) => r.q === `transfer.sender='${P3005}'` && r.per === 50).length).toBe(1);
    // the stream's four queries are read as before
    for (const q of OSMOSIS_QUERIES) expect(reads.some((r) => r.q === q && r.per === 50)).toBe(true);
    // a second search finds both stored or seen: nothing written again
    await hub.sweepOsmosis();
    expect(legRows(db).length).toBe(2);
  });

  it('a database without pool_legs: the legs are logged as not written, and the cursor still moves', async () => {
    const db = await seeded();
    db.exec('DROP TABLE pool_legs');
    osmosis(db);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = hubOn(db);
    await hub.sweepOsmosis();
    expect(errors.mock.calls.filter((c) => /pool legs of .* not written/.test(String(c[0]))).length).toBe(2);
    errors.mockRestore();
    expect(cursorOf(db)).toMatchObject({ height: HEAD });
    expect(cursorOf(db).error).toBeUndefined();
  });

  it('with no pool known (the router not read yet) the search asks only the stream\'s four queries, as before', async () => {
    const db = await seeded();
    const reads = osmosis(db);
    await hubOn(db, new Map()).sweepOsmosis();
    expect(new Set(reads.map((r) => r.q))).toEqual(new Set(OSMOSIS_QUERIES));
    expect(legRows(db)).toEqual([]);
  });
});

describe('no NAM figure reads pool_legs', () => {
  it('the only SQL in the Worker, the page and shared code that names the table is its write (db.ts stmt.poolLeg)', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
    for (const d of ['worker/src', 'web/src', 'shared']) walk(join(__dirname, '..', d));
    // the SQL here is written in capitals; a comment's "table pool_legs" is not a read
    const uses = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+pool_legs\b/g)].map((m) => `${f.split('/').slice(-2).join('/')}: ${m[0]}`));
    expect(uses).toEqual(['src/db.ts: INTO pool_legs']);
    // the page and the shared code do not name it at all
    expect(files.filter((f) => !f.includes('/worker/src/') && readFileSync(f, 'utf8').includes('pool_legs'))).toEqual([]);
  });

  it('a pool address that is not a pool account goes into no query', () => {
    expect(osmosisPoolQueries(P3005)).toEqual([`transfer.sender='${P3005}'`, `transfer.recipient='${P3005}'`]);
    expect(osmosisPoolQueries("osmo1x' OR tx.height>0 AND '")).toEqual([]);
    expect(osmosisPoolQueries('osmo1recv')).toEqual([]);
  });
});
