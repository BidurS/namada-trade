// Every move the live hub writes says how its price was set: a row priced at the quote for its minute carries
// meta.priceSource 'spot' (a bridge record, a transfer, a pool move, a Namada move, as the trades and the PoS requests
// already did), a row with no price says nothing, and a quote that was the spot of a route the Osmosis router quoted
// (the price list gave NAM no price) carries the route's size too (meta.priceRoute), read from the hub's own ask or,
// for a stored quote, the cron's log of how it read the price (kv price.how).
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normFromTxSearch, parseOsmosisTx, type OsmoCtx } from '../worker/src/parse/osmosis';
import { parseNamadaBlock } from '../worker/src/parse/namada';
import { HubQuote } from '../worker/src/live-quote';
import { priceRouteAt, resetPriceRouteCopy, stampPriceRoute } from '../worker/src/price-how';
import { priceHowOf, priceRouteOf, priceBasisWords } from '../shared/flow-rules';
import { testD1, insert } from './d1-sqlite';
import type { Flow } from '../shared/types';
import { NAM } from '../worker/src/config';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';

afterEach(() => vi.unstubAllGlobals());

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', n), 'utf8'));
const ctx = (priceUsd: number | null): OsmoCtx => ({ poolAddrs: new Map(), priceUsd, assets: new Map([['uosmo', { symbol: 'OSMO', decimals: 6 }]]) });

describe('a priced row says it was priced at the quote', () => {
  it('Osmosis bridge records priced at the minute\'s quote carry priceSource spot; unpriced ones carry none', () => {
    for (const file of ['osmo_ibc_send.json', 'osmo_ibc_recv.json']) {
      const raw = fx(file)[0] ?? fx(file);
      const priced = parseOsmosisTx(normFromTxSearch(raw, 1), ctx(0.00087)).flows.filter((f) => f.kind === 'ibc_in' || f.kind === 'ibc_out');
      expect(priced.length, file).toBeGreaterThan(0);
      for (const f of priced) {
        expect(f.meta?.priceSource, file).toBe('spot');
        expect(priceHowOf(f)).toBe('spot');
      }
      for (const f of parseOsmosisTx(normFromTxSearch(raw, 1), ctx(null)).flows) expect(f.meta?.priceSource).toBeUndefined();
    }
  });
  it('a Namada move priced at the block\'s quote carries priceSource spot', () => {
    const r = fx('namada_block_8261880.json').result;
    const p = parseNamadaBlock({ height: 8261880, ts: 1, events: [...(r.end_block_events ?? [])] }, 0.00087);
    const nam = p.flows.filter((f) => !f.meta?.tokenSymbol);
    expect(nam.length).toBeGreaterThan(0);
    for (const f of nam) expect(f.meta?.priceSource).toBe('spot');
    const unpriced = parseNamadaBlock({ height: 8261880, ts: 1, events: [...(r.end_block_events ?? [])] }, null);
    for (const f of unpriced.flows) expect(f.meta?.priceSource).toBeUndefined();
  });
});

describe('a quote that was a route\'s spot is marked with the route', () => {
  beforeEach(() => resetPriceRouteCopy());
  it('stampPriceRoute marks only rows priced at the quote, and only with a route', () => {
    const flows = [
      { priceUsd: 0.0009, meta: { priceSource: 'spot' } },
      { priceUsd: 0.0009, meta: null },
      { priceUsd: null, meta: { priceSource: 'spot' } },
      { priceUsd: 0.0009, meta: { priceSource: 'execution' } },
    ];
    stampPriceRoute(flows, 1000);
    expect(flows.map((f) => f.meta?.priceRoute ?? null)).toEqual([1000, null, null, null]);
    const again = [{ priceUsd: 0.0009, meta: { priceSource: 'spot' } }];
    stampPriceRoute(again, null);
    expect(again[0].meta).toEqual({ priceSource: 'spot' });
  });
  it('the hub\'s own ask says the route\'s size; a stored quote does not, and its minute\'s way is the cron\'s log', async () => {
    const q = new HubQuote(async () => ({ usd: 0.0009, priceSource: 'Osmosis SQS route spot, 1,000 NAM', routeNam: 1000 }), async () => null);
    const t = Date.now();
    await q.refresh(t);
    expect(await q.quoteFor(t - 1000, t)).toEqual({ usd: 0.0009, at: t, stored: false, routeNam: 1000 });
    const s = new HubQuote(async () => null, async (ts) => ({ usd: 0.00088, at: ts - 30_000 }));
    expect(await s.quoteFor(t - 3_600_000, t)).toEqual({ usd: 0.00088, at: t - 3_630_000, stored: true });
    const db = testD1();
    insert(db, 'kv', [{ key: 'price.how', value: JSON.stringify({ log: [{ how: 'list', since: t - 10 * 3_600_000 }, { how: 'route', refNam: 1000, routes: [], liquidityUsd: null, since: t - 2 * 3_600_000 }] }), updated_at: t }]);
    expect(await priceRouteAt(db as any, t - 3_630_000, t)).toBe(1000);
    expect(await priceRouteAt(db as any, t - 5 * 3_600_000, t)).toBeNull();
  });
  it('the moves list names a route\'s quote by its size', () => {
    const f = { meta: { priceSource: 'spot', priceRoute: 1000 } } as unknown as Flow;
    expect(priceRouteOf(f)).toBe(1000);
    expect(priceBasisWords('spot', null, priceRouteOf(f))).toBe('the Osmosis route quote for selling 1,000 NAM when the move was recorded');
    expect(priceBasisWords('spot', null)).toBe('the Osmosis quote when the move was recorded');
  });
});

describe('the live hub writes the marks', () => {
  /** A real bridge receive (test/fixtures/osmo_ibc_recv.json) as a stream message, in its own packet. */
  const message = (hash: string, seq: string) => {
    const events = fx('osmo_ibc_recv.json')[0].tx_result.events.map((e: any) => ({ ...e, attributes: e.attributes.map((a: any) => (e.type === 'recv_packet' && a.key === 'packet_sequence' ? { ...a, value: seq } : a)) }));
    return { result: { data: { value: { TxResult: { height: '100', result: { code: 0, events } } } }, events: { 'tx.hash': [hash] } } };
  };
  const hubWith = (db: any, quote: HubQuote) => Object.assign(Object.create(LiveHub.prototype), {
    env: { DB: db }, seenOsmoTx: new Set<string>(), osmoRetryTx: new Map<string, number>(), osmoWriting: new Map(), osmoRetryFrom: null, osmoRetryGen: 0,
    osmoHeight: 0, sessions: new Set(), lastPriceUsd: null, osmoCtx: { poolAddrs: new Map(), priceUsd: null, assets: new Map() }, quote,
  });
  const stored = (db: any, hash: string) => JSON.parse(db.raw.prepare('SELECT meta FROM flows WHERE tx_hash = ?').get(hash).meta);
  beforeEach(() => resetPriceRouteCopy());
  it('a move priced by the hub\'s own ask of a route\'s spot is stored with the quote and the route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const db = testD1();
    const quote = new HubQuote(async () => ({ usd: 0.0009, priceSource: 'Osmosis SQS route spot, 1,000 NAM', routeNam: 1000 }), async () => null);
    await quote.refresh(Date.now());
    await hubWith(db, quote).handleOsmosisMessage(message('STAMPROUTE1', '90001'));
    expect(stored(db, 'STAMPROUTE1')).toMatchObject({ priceSource: 'spot', priceRoute: 1000, channel: NAM.osmoChannel });
  });
  it('a move priced at a stored quote takes the route from the cron\'s log; one of the price list\'s takes no mark', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    const db = testD1();
    const t = Date.now();
    insert(db, 'kv', [{ key: 'price.how', value: JSON.stringify({ log: [{ how: 'route', refNam: 1000, routes: [], liquidityUsd: null, since: t - 3_600_000 }] }), updated_at: t }]);
    const quote = new HubQuote(async () => null, async (ts) => ({ usd: 0.00088, at: ts - 20_000 }));
    await quote.refresh(t);
    await hubWith(db, quote).handleOsmosisMessage(message('STAMPROUTE2', '90002'));
    expect(stored(db, 'STAMPROUTE2')).toMatchObject({ priceSource: 'spot', priceRoute: 1000 });
    resetPriceRouteCopy();
    const list = testD1();
    const listQuote = new HubQuote(async () => ({ usd: 0.0009, priceSource: 'Osmosis SQS', routeNam: null }), async () => null);
    await listQuote.refresh(Date.now());
    await hubWith(list, listQuote).handleOsmosisMessage(message('STAMPROUTE3', '90003'));
    const m = stored(list, 'STAMPROUTE3');
    expect(m.priceSource).toBe('spot');
    expect(m.priceRoute).toBeUndefined();
  });
});
