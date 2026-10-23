// Security review (2026-10-22), live scan head: a node that says it is ahead never becomes the only source of the
// chain's blocks. Two nodes within HEAD_AGREE_BLOCKS of each other agree, and the scan follows the LOWER of them (a
// height both say the chain has reached): before, it followed the higher, so a node claiming up to 100 blocks more
// served every block above the honest head and the real blocks there were never read. And on one node's word the
// scan goes only as far as the chain can have gone since the last agreed head (or, with none known, since the
// indexer's latest block): before, a lone node far ahead was followed 50 blocks a tick for as long as it lied, and the
// honest node, back again, was left out for good.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { LiveHub } from '../worker/src/live-hub';
import { HubQuote } from '../worker/src/live-quote';
import { NAMADA } from '../worker/src/config';
import { testD1, type TestD1 } from './d1-sqlite';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const X = 'tnam1qr4wemkpjfycn7ts7297e8qecg2t6pf2vq2wulsa';
const OSMO = 'osmo19v0z78d8gv02t4cfqvmtklppu4rmpp5ek3q9a8';
const recvEvents = () => JSON.parse(readFileSync(join(__dirname, 'fixtures', 'namada_block_7153723.json'), 'utf8')).result.end_block_events
  .map((e: any) => ({ ...e, attributes: e.attributes.map((a: any) => ({ ...a, value: String(a.value).split(NAMADA.internal.masp).join(X) })) }));

interface NodeSpec { height: number; down?: boolean; events?: Record<number, any[]> }
function chain(spec: { five: NodeSpec; papa: NodeSpec }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    const url = new URL(String(u));
    const who = url.host.includes('5elementsnodes') ? 'five' : 'papa';
    const n = spec[who];
    calls.push(`${who} ${url.pathname}${url.search}`);
    if (n.down) throw new Error('refused');
    if (url.pathname === '/status') {
      return Response.json({ result: { node_info: { network: NAMADA.chainId }, sync_info: { latest_block_height: String(n.height), latest_block_time: new Date().toISOString(), catching_up: false, earliest_block_height: '1' } } });
    }
    if (url.pathname === '/blockchain') {
      const lo = Number(url.searchParams.get('minHeight')), hi = Math.min(Number(url.searchParams.get('maxHeight')), n.height);
      if (lo > hi) return Response.json({ error: { code: -32603, message: 'Internal error' } });
      const metas = [];
      for (let h = hi; h >= lo; h--) metas.push({ header: { chain_id: NAMADA.chainId, height: String(h), time: new Date().toISOString() }, num_txs: '0' });
      return Response.json({ result: { last_height: String(n.height), block_metas: metas } });
    }
    if (url.pathname === '/block_results') {
      const h = Number(url.searchParams.get('height'));
      if (h > n.height) return Response.json({ error: { code: -32603, message: 'Internal error' } });
      return Response.json({ result: { height: String(h), end_block_events: n.events?.[h] ?? [] } });
    }
    throw new Error(`unexpected ${url}`);
  }));
  return calls;
}
const hubOf = (db: TestD1) => Object.assign(Object.create(LiveHub.prototype), {
  env: { DB: db }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote: new HubQuote(async () => null, async () => null),
}) as any;
const cursor = (db: TestD1) => Number((db.raw.prepare("SELECT value FROM kv WHERE key = 'namada.cursor'").get() as any)?.value);
const setCursor = (db: TestD1, v: number) => db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(String(v));
const link = (db: TestD1) => db.raw.prepare('SELECT transfers FROM address_links WHERE osmo_addr = ? AND namada_addr = ?').get(OSMO, X) as any;
const blockReads = (calls: string[], who: string) => calls.filter((c) => c.startsWith(who) && !c.endsWith('/status'));
/** checks 'indexer_lag' exactly as cron.ts writes it: lagBlocks = the highest node height that answered minus the indexer's. */
const cronVote = (db: TestD1, indexerHeight: number, maxNodeHeight: number, at = Date.now()) =>
  db.raw.prepare("INSERT OR REPLACE INTO checks (key, status, title, detail, checked_at) VALUES ('indexer_lag', 'ok', 'indexer', ?, ?)")
    .run(JSON.stringify({ indexerHeight, rpcHeight: maxNodeHeight, lagBlocks: maxNodeHeight - indexerHeight }), at);

const H = 8_300_000;


describe('two nodes that agree: the scan follows the lower', () => {
  it('a node that claims 100 blocks more than the honest one serves no block above the honest head; the honest blocks are all read', async () => {
    const db = testD1();
    setCursor(db, H);
    const spec = { five: { height: H, events: { [H + 5]: recvEvents() } } as NodeSpec, papa: { height: H + 100 } as NodeSpec };
    const hub = hubOf(db);
    const logs: string[][] = [];
    for (let t = 0; t < 10; t++) {
      spec.five.height = H + t; spec.papa.height = H + t + 100;
      cronVote(db, H + t, H + t + 100);
      logs.push(chain(spec));
      await hub.scanNamada();
    }
    expect(cursor(db)).toBe(spec.five.height);
    expect(blockReads(logs.flat(), 'five').some((c) => c.includes(`height=${H + 5}`))).toBe(true);
    expect(link(db)?.transfers).toBe(1);
  });
});

describe('one node alone is followed only as far as the chain can have gone', () => {
  it('a lone node far ahead after an agreed head is never followed past the bound, and the honest node, back, is followed again', async () => {
    const db = testD1();
    setCursor(db, H);
    const spec = { five: { height: H } as NodeSpec, papa: { height: H } as NodeSpec };
    const hub = hubOf(db);
    chain(spec);
    await hub.scanNamada(); // both agree on H
    spec.five.down = true; spec.papa.height = H + 300_000;
    for (let t = 0; t < 3; t++) {
      cronVote(db, H + t, H + 300_000 + t);
      chain(spec);
      await hub.scanNamada();
    }
    expect(cursor(db)).toBe(H); // H + 300,000 is past H + 100: waits
    spec.five.down = false;
    const logs: string[][] = [];
    for (let t = 3; t < 23; t++) {
      spec.five.height = H + t; spec.papa.height = H + 300_000 + t;
      cronVote(db, H + t, H + 300_000 + t);
      logs.push(chain(spec));
      await hub.scanNamada();
    }
    expect(cursor(db)).toBe(spec.five.height);
    expect(blockReads(logs.flat(), 'papa')).toEqual([]);
  });

  it('with no agreed head known (a first start with one node down), the indexer\'s latest block bounds a lone node far ahead', async () => {
    const db = testD1();
    setCursor(db, H);
    const spec = { five: { height: H, down: true } as NodeSpec, papa: { height: H + 300_000 } as NodeSpec };
    const hub = hubOf(db);
    for (let t = 0; t < 3; t++) {
      cronVote(db, H + t, H + 300_000 + t);
      chain(spec);
      await hub.scanNamada();
    }
    expect(cursor(db)).toBe(H);
    spec.five.down = false;
    for (let t = 3; t < 23; t++) {
      spec.five.height = H + t; spec.papa.height = H + 300_000 + t;
      cronVote(db, H + t, H + 300_000 + t);
      chain(spec);
      await hub.scanNamada();
    }
    expect(cursor(db)).toBe(spec.five.height);
  });

  it('an honest node alone is still followed while the indexer lags up to 500 blocks', async () => {
    const db = testD1();
    setCursor(db, H);
    const spec = { five: { height: H + 40 } as NodeSpec, papa: { height: 1, down: true } as NodeSpec };
    cronVote(db, H - 400, H + 40);
    chain(spec);
    await hubOf(db).scanNamada();
    expect(cursor(db)).toBe(H + 40);
  });
});
