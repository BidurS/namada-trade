// Security review (2026-10-22), live scan head: a lying node held just under the bound for outages of the honest node of
// several lengths, with the indexer up or down, and the indexer's vote vouching for a node up to 100 blocks above it on
// a tick the honest node's status timed out. The honest node is followed again on its return, no block is jumped on
// one node's word with the indexer, and the scan follows no higher than the indexer's block.
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
function chain(spec: { five: NodeSpec; papa: NodeSpec }, calls: string[]) {
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
}
const hubOf = (db: TestD1) => Object.assign(Object.create(LiveHub.prototype), {
  env: { DB: db }, sessions: new Set(), lastPriceUsd: null, namadaHeight: 0, quote: new HubQuote(async () => null, async () => null),
}) as any;
const cursor = (db: TestD1) => Number((db.raw.prepare("SELECT value FROM kv WHERE key = 'namada.cursor'").get() as any)?.value);
const setCursor = (db: TestD1, v: number) => db.raw.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('namada.cursor', ?, 0)").run(String(v));
const link = (db: TestD1) => db.raw.prepare('SELECT transfers FROM address_links WHERE osmo_addr = ? AND namada_addr = ?').get(OSMO, X) as any;
const notes = (db: TestD1) => JSON.parse((db.raw.prepare("SELECT value FROM kv WHERE key='namada.scan'").get() as any)?.value ?? '{"failures":[]}').failures.map((f: any) => `${f.height}: ${f.note}`);
const blockReads = (calls: string[], who: string) => calls.filter((c) => c.startsWith(who) && !c.endsWith('/status'));
const cronVote = (db: TestD1, indexerHeight: number, maxNodeHeight: number, at = Date.now()) =>
  db.raw.prepare("INSERT OR REPLACE INTO checks (key, status, title, detail, checked_at) VALUES ('indexer_lag', 'ok', 'indexer', ?, ?)")
    .run(JSON.stringify({ indexerHeight, rpcHeight: maxNodeHeight, lagBlocks: maxNodeHeight - indexerHeight }), at);

const H = 8_300_000;
const TICK_MS = 6500, BLOCK_MS = 6800;

async function captureRun(outageTicks: number, withIndexer: boolean) {
  vi.useFakeTimers({ toFake: ['Date'] });
  const t0 = Date.UTC(2026, 9, 22, 12, 0, 0);
  vi.setSystemTime(t0);
  const real = () => H + Math.floor((Date.now() - t0) / BLOCK_MS);
  const db = testD1();
  setCursor(db, H);
  const spec = { five: { height: H, events: {} } as NodeSpec, papa: { height: H } as NodeSpec };
  const hub = hubOf(db);
  const calls: string[] = [];
  if (withIndexer) cronVote(db, H, H);
  chain(spec, calls);
  await hub.scanNamada();
  const claim = () => H + Math.floor((Date.now() - t0) / 5000) + 100 - 2;
  let tick = 0, lastCron = t0;
  const step = async () => {
    tick++;
    vi.setSystemTime(t0 + tick * TICK_MS);
    if (!spec.five.down) spec.five.height = real();
    spec.papa.height = claim();
    if (withIndexer && Date.now() - lastCron >= 60_000) {
      lastCron = Date.now();
      cronVote(db, real(), Math.max(spec.papa.height, ...(spec.five.down ? [] : [spec.five.height])));
    }
    chain(spec, calls);
    await hub.scanNamada();
  };
  spec.five.down = true;
  for (let i = 0; i < outageTicks; i++) await step();
  const atReturn = { cursor: cursor(db), real: real() };
  spec.five.down = false;
  const receiptAt = real() + 10;
  spec.five.events = { [receiptAt]: recvEvents() };
  const before = calls.length;
  for (let i = 0; i < 200; i++) await step(); // 21.7 min with both nodes up
  const after = calls.slice(before);
  return { atReturn, end: { cursor: cursor(db), five: spec.five.height, papa: spec.papa.height }, fiveReads: blockReads(after, 'five').length, papaReads: blockReads(after, 'papa').length, link: link(db)?.transfers ?? 0, notes: notes(db) };
}

describe('(A) variants', () => {
  for (const withIndexer of [false, true]) for (const n of [3, 5, 8, 10, 14]) {
    it(`outage ${n} ticks, indexer ${withIndexer ? 'up (cron row as written)' : 'down (no row)'}`, async () => {
      const r = await captureRun(n, withIndexer);
      console.log(`A n=${n} idx=${withIndexer}`, JSON.stringify(r));
      expect(r.fiveReads).toBeGreaterThan(0);
    });
  }
});

describe('(C) the vote vouches for a node up to 100 above the indexer: one status timeout of the honest node', () => {
  it('makes no jump past the real head and skips no real block', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.UTC(2026, 9, 22, 12, 0, 0);
    vi.setSystemTime(t0);
    const real = () => H + Math.floor((Date.now() - t0) / BLOCK_MS);
    const db = testD1();
    setCursor(db, H);
    const receiptAt = H + 20; // made about 2.3 min after t0
    const spec = { five: { height: H, events: { [receiptAt]: recvEvents() } } as NodeSpec, papa: { height: H + 95 } as NodeSpec };
    const hub = hubOf(db);
    const calls: string[] = [];
    // papa always says 95 above the real head; with both up the scan follows five (the lower) and nothing is lost
    cronVote(db, H, H + 95); // as cron.ts writes it: lag 95 against the highest node
    chain(spec, calls);
    await hub.scanNamada();
    let tick = 0;
    const step = async (fiveDown = false) => {
      tick++;
      vi.setSystemTime(t0 + tick * TICK_MS);
      spec.five.height = real(); spec.five.down = fiveDown;
      spec.papa.height = real() + 95;
      if (tick % 9 === 0) cronVote(db, real(), real() + 95);
      chain(spec, calls);
      await hub.scanNamada();
    };
    for (let i = 0; i < 3; i++) await step();
    const c1 = cursor(db);
    await step(true); // one tick: 5ElementsNodes' status over 3 s
    const c2 = { cursor: cursor(db), real: real() };
    for (let i = 0; i < 120; i++) await step(); // 13 min
    console.log('C before', c1, 'after the one tick', JSON.stringify(c2), 'end cursor', cursor(db), 'real', real(), 'link', JSON.stringify(link(db)), 'notes', JSON.stringify(notes(db)));
    expect(c2.cursor).toBeLessThanOrEqual(c2.real);
    expect(link(db)?.transfers).toBe(1);
  });
});
